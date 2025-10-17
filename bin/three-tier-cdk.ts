#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ThreeTierCdkStack } from '../lib/three-tier-cdk-stack';

const app = new cdk.App();
new ThreeTierCdkStack(app, 'ThreeTierStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-south-1',
  },
});

