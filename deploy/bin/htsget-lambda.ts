#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {HtsgetLambdaStack} from '../lib/htsget-lambda-stack';

export const STACK_NAME = 'HtsgetLambdaStack';
const STACK_DESCRIPTION = 'An example stack for testing htsget-lambda with API gateway.';

const app = new cdk.App();
new HtsgetLambdaStack(app, STACK_NAME, {
    stackName: STACK_NAME,
    description: STACK_DESCRIPTION,
    tags: {
        Stack: STACK_NAME,
    },
});