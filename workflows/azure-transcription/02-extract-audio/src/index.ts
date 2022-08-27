import { Context } from "aws-lambda";
import * as AWSXRay from "aws-xray-sdk-core";

import {
    JobParameterBag,
    JobProfile,
    McmaException,
    McmaTracker,
    NotificationEndpoint,
    NotificationEndpointProperties, TransformJob
} from "@mcma/core";
import { AwsCloudWatchLoggerProvider } from "@mcma/aws-logger";
import { S3Locator } from "@mcma/aws-s3";
import { AuthProvider, getResourceManagerConfig, ResourceManager } from "@mcma/client";
import { awsV4Auth } from "@mcma/aws-client";

const { ActivityArn } = process.env;

const AWS = AWSXRay.captureAWS(require("aws-sdk"));
const stepFunctions = new AWS.StepFunctions();
const s3 = new AWS.S3({ signatureVersion: "v4" });

const loggerProvider = new AwsCloudWatchLoggerProvider("azure-transcription-02-extract-audio", process.env.LogGroupName);
const resourceManager = new ResourceManager(getResourceManagerConfig(), new AuthProvider().add(awsV4Auth(AWS)));

type InputEvent = {
    input: {
        mediaWorkflowId?: string
        mediaAssetId?: string
        mediaAssetWorkflowId?: string
        inputFile?: S3Locator
    }
    tracker?: McmaTracker
    notificationEndpoint: NotificationEndpointProperties
}

export async function handler(event: InputEvent, context: Context) {
    const logger = loggerProvider.get(context.awsRequestId, event.tracker);
    try {
        logger.functionStart(context.awsRequestId);
        logger.debug(event);
        logger.debug(context);

        const data = await stepFunctions.getActivityTask({ activityArn: ActivityArn }).promise();
        logger.info(data);

        const taskToken = data.taskToken;
        if (!taskToken) {
            throw new McmaException("Failed to obtain activity task");
        }

        // using input from activity task to ensure we don't have race conditions if two workflows execute simultaneously.
        event = JSON.parse(data.input);

        const notificationUrl = event.notificationEndpoint.httpEndpoint + "?taskToken=" + encodeURIComponent(taskToken);
        logger.info(`NotificationUrl: ${notificationUrl}`);

        const [jobProfile] = await resourceManager.query(JobProfile, { name: "FFmpegExtractAudio" });
        if (!jobProfile) {
            throw new McmaException("JobProfile 'FFmpegExtractAudio' not found.");
        }

        const inputFile = event.input.inputFile;
        inputFile.url = s3.getSignedUrl("getObject", {
            Bucket: inputFile.bucket,
            Key: inputFile.key,
            Expires: 3600
        });
        
        let job = new TransformJob({
            jobProfileId: jobProfile.id,
            jobInput: new JobParameterBag({
                inputFile,
                audioCodec: "pcm_s16le",
                outputFormat: "wav",
            }),
            notificationEndpoint: new NotificationEndpoint({
                httpEndpoint: notificationUrl
            }),
            tracker: event.tracker
        });

        logger.info("Creating job...");
        job = await resourceManager.create(job);

        logger.info(job);
    } catch (error) {
        logger.error("Failed to start transform job");
        logger.error(error);
        throw new McmaException("Failed to start transform job", error);
    } finally {
        logger.functionEnd(context.awsRequestId);
        await loggerProvider.flush();
    }
}