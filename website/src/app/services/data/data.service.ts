import { Injectable, OnInit } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { Observable, zip } from "rxjs";
import { filter, map, retry, share, switchMap, tap } from "rxjs/operators";
import { webSocket } from "rxjs/webSocket";
import { McmaResource } from "@mcma/core";
import { QueryResults } from "@mcma/data";
import { AwsV4PresignedUrlGenerator } from "@mcma/aws-client";
import { MediaAsset, MediaWorkflow } from "@local/model";

import { ConfigService } from "../config";
import { CognitoAuthService } from "../cognito-auth";
import { LoggerService } from "../logger";
import { DataOperation, DataUpdate } from "./data-update";

@Injectable({
  providedIn: "root"
})
export class DataService implements OnInit {
  private websocket$: Observable<any>;

  constructor(private http: HttpClient,
              private config: ConfigService,
              private auth: CognitoAuthService,
              private logger: LoggerService,
  ) {
    this.websocket$ = zip(
      this.config.get<string>("WebSocketUrl"),
      zip(
        this.config.get<string>("AwsRegion"),
        this.auth.getCredentials(),
      ).pipe(
        map(([region, credentials]) => {
          return {
            accessKey: credentials.accessKeyId,
            secretKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
            region,
          };
        }),
        map((credentials) => new AwsV4PresignedUrlGenerator(credentials)),
      )
    ).pipe(
      map(([url, presignedUrlGenerator]) => presignedUrlGenerator.generatePresignedUrl("GET", url)),
      switchMap(url => webSocket(url)),
      retry(),
      map(obj => obj as DataUpdate<McmaResource>),
      filter(dataUpdate => dataUpdate.operation === DataOperation.Insert || dataUpdate.operation === DataOperation.Update || dataUpdate.operation === DataOperation.Delete),
      share(),
    );
  }

  ngOnInit(): void {

  }

  private getRestApiUrl() {
    return this.config.get<string>("RestApiUrl");
  }

  createWorkflow(workflow: MediaWorkflow) {
    return this.getRestApiUrl().pipe(
      switchMap(url => this.http.post<MediaWorkflow>(`${url}/workflows`, workflow))
    );
  }

  listWorkflows() {
    return this.getRestApiUrl().pipe(
      switchMap(url => this.http.get<QueryResults<MediaWorkflow>>(`${url}/workflows`))
    );
  }

  listMediaAssets(pageSize: number, pageStartToken?: string) {
    const params: any = {
      sortBy: "dateCreated",
      sortOrder: "desc",
      pageSize: pageSize,
    };
    if (pageStartToken) {
      params.pageStartToken = pageStartToken;
    }
    return this.getRestApiUrl().pipe(
      switchMap(url => this.http.get<QueryResults<MediaAsset>>(`${url}/assets`, {
        params: params
      }))
    );
  }

  getMediaAssetUpdates(): Observable<DataUpdate<MediaAsset>> {
    return this.websocket$.pipe(
      tap(x => this.logger.info(x)),
      filter(obj => obj.resource && obj.resource["@type"] === "MediaAsset"),
    );
  }
}
