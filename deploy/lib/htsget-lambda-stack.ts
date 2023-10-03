import { STACK_NAME } from "../bin/htsget-lambda";
import * as TOML from "@iarna/toml";
import { readFileSync } from "fs";

import { Duration, Stack, StackProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import { RustFunction, Settings } from "rust.aws-cdk-lambda";

import { UserPool } from "aws-cdk-lib/aws-cognito";
import { Role, ServicePrincipal, PolicyStatement, ManagedPolicy } from "aws-cdk-lib/aws-iam";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { CorsHttpMethod, HttpMethod, HttpApi } from "@aws-cdk/aws-apigatewayv2-alpha";
import { HttpLambdaIntegration } from "@aws-cdk/aws-apigatewayv2-integrations-alpha";
import { HttpJwtAuthorizer } from "@aws-cdk/aws-apigatewayv2-authorizers-alpha";
import { Certificate, CertificateValidation } from "aws-cdk-lib/aws-certificatemanager";
import { HostedZone } from "aws-cdk-lib/aws-route53";

/**
 * Configuration for HtsgetLambdaStack.
 */
export type Config = {
  domain: string;                               // TODO: Ditto above
  environment: string;                          // Dev, prod, public
  htsgetConfig: { [key: string]: any };         // Server config
  allowCredentials?: boolean;                   // CORS
  allowHeaders?: string[];
  allowMethods?: CorsHttpMethod[];
  allowOrigins?: string[];
  exposeHeaders?: string[];
  maxAge?: Duration;
  authRequired?: boolean;                       // Public instance without authz/n
  rateLimits?: boolean;                         // Reasonable defaults or configurable ratelimit settings?
  cogUserPoolId?: string;                       // Supply one if already existing
};

/**
 * Stack used to deploy htsget-lambda.
 */
export class HtsgetLambdaStack extends Stack {
  // Read config from cdk.json and TOML file(s).
  config = this.getConfig();

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const config = this.config;

    Tags.of(this).add("Stack", STACK_NAME);

    const lambdaRole = new Role(this, id + "Role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: "Lambda execution role for " + id,
    });

    const s3BucketPolicy = new PolicyStatement({
      actions: ["s3:List*", "s3:Get*"],
      resources: this.configResolversToARNBuckets(config.htsgetConfig),
    });

    lambdaRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AWSLambdaBasicExecutionRole"
      )
    );
    lambdaRole.addToPolicy(s3BucketPolicy);

    // Set the workspace directory of htsget.
    Settings.WORKSPACE_DIR = "../";
    // Don't build htsget packages other than htsget-lambda.
    Settings.BUILD_INDIVIDUALLY = true;


    let htsgetLambda = new RustFunction(this, id + "Function", {
      // Build htsget-lambda only.
      package: "htsget-lambda",
      target: "aarch64-unknown-linux-gnu",

      memorySize: 128,
      timeout: Duration.seconds(28),
      environment: {
        ...config.htsgetConfig,
        RUST_LOG:
          "info,htsget_http_lambda=trace,htsget_config=trace,htsget_http_core=trace,htsget_search=trace",
      },
      features: ["s3-storage"],
      buildEnvironment: {
        RUSTFLAGS: "-C target-cpu=neoverse-n1",
        CARGO_PROFILE_RELEASE_LTO: "true",
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
      },
      architecture: Architecture.ARM_64,
      role: lambdaRole,
    });

    const httpIntegration = new HttpLambdaIntegration(
      id + "HtsgetIntegration",
      htsgetLambda
    );

    // Use a predefined Cognito user pool or create a new one.
    var cognito = undefined;
    if (!config.authRequired || config.cogUserPoolId) {
      Error("Cognito user pool requested by {toml.cognito_name} not found");
      cognito = config.cogUserPoolId;
    } else {
      cognito = this.createNewCognito();
    }

    // Use a predefined authorizer or create a new one.
    var authorizer = undefined;
    if (config.authRequired) {
      authorizer = new HttpJwtAuthorizer(
      id + "HtsgetAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${config.cogUserPoolId}`,
        {
          identitySource: ["$request.header.Authorization"],
          jwtAudience: ["audience"], // TODO
        }
      )
    }

    // Create a hosted zone for this service.
    // TODO: Make sure it's not created already, fail gracefully if so.
    const hostedZoneObj = new HostedZone(this, id + "HtsgetHostedZone", {
      zoneName: config.domain,
    });

    // Create a certificate for the domain name.
    const certificateArn = new Certificate(
      this,
      id + "HtsgetCertificate",
      {
        // TODO: Add this in config
        domainName: config.domain,
        validation: CertificateValidation.fromDns(hostedZoneObj),
        certificateName: config.domain,
      }
    ).certificateArn;

    console.log(config.htsgetConfig);

    const httpApi = new HttpApi(this, id + "ApiGw", {
      // Use explicit routes GET, POST with {proxy+} path
      // defaultIntegration: httpIntegration,
      defaultAuthorizer: config.authRequired ? authorizer : undefined,
      corsPreflight: {
        allowCredentials: config.allowCredentials,
        allowHeaders: config.allowHeaders,
        allowMethods: config.allowMethods,
        allowOrigins: config.allowOrigins,
        exposeHeaders: config.exposeHeaders,
        maxAge: config.maxAge,
      },
    });

    httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [HttpMethod.GET, HttpMethod.POST],
      integration: httpIntegration,
    });
  }

  /**
   * Convert JSON config to htsget-rs env representation.
   */
  static configToEnv(config: any): { [key: string]: string } {
    const out: { [key: string]: string } = {};
    for (const key in config) {
      out[`HTSGET_${key.toUpperCase()}`] = TOML.stringify.value(config[key]);
    }
    return out;
  }

  /**
   * Collect resource names from config.
   * @param config TOML config file
   * @returns A list of buckets (storage backend identifiers or names)
   */

  configResolversToARNBuckets(config: any): string[] {
    // Example return value:
    //  [ "arn:aws:s3:::org.umccr.demo.sbeacon-data/*",
    //    "arn:aws:s3:::org.umccr.demo.htsget-rs-data/*" ]

    // TODO: Make sure it visits all resolvers from a TOML file
    var out: string[] = [];
    const s3_arn_fmt = `arn:aws:s3:::{}/*`;
    for (const key in config) {
      if (key.includes("resolvers")) {
        // TODO: Extract the "regex" substring from the key
        out.push(s3_arn_fmt.replace("{}", config[key].resolvers));
      }
    }
    return out;
  }

  /**
   * Convert htsget-rs CORS option to CORS options for API Gateway.
   */
  static convertCors(configToml: any, corsValue: string): string[] | undefined {
    const value = configToml[corsValue];

    if (
      value !== undefined &&
      (value.toString().toLowerCase() === "all" ||
        value.toString().toLowerCase() === "mirror")
    ) {
      return ["*"];
    } else if (Array.isArray(value)) {
      return value;
    }

    return undefined;
  }
  
  /**
   * Convert a string CORS allowMethod option to CorsHttpMethod.
   */
  static corsAllowMethodToHttpMethod(
    corsAllowMethod?: string[]
  ): CorsHttpMethod[] | undefined {
    if (corsAllowMethod?.length === 1 && corsAllowMethod.includes("*")) {
      return [CorsHttpMethod.ANY];
    } else {
      return corsAllowMethod?.map(
        (element) =>
          CorsHttpMethod[element as keyof typeof CorsHttpMethod]
      );
    }
  }

  /**
   * Bespoke Cognito infrastructure
   */
  createNewCognito() {
      // Cognito User Pool with Email Sign-in Type.
      const userPool = new UserPool(this, 'userPool', {
        userPoolName: 'HtsgetRsUserPool',
      })
  
      // Authorizer for the Hello World API that uses the
      // Cognito User pool to Authorize users.
      // const authorizer = new CfnAuthorizer(this, 'cfnAuth', {
      //   restApiId: helloWorldLambdaRestApi.restApiId,
      //   name: 'HelloWorldAPIAuthorizer',
      //   type: 'COGNITO_USER_POOLS',
      //   identitySource: 'method.request.header.Authorization',
      //   providerArns: [userPool.userPoolArn],
      // })
  }
  /**
   * Get the environment from config.toml
   */
  getConfig(): Config {
    let env = this.node.tryGetContext("env");

    if (env === undefined) {
      env = {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      }
    }
    // TODO: Remove hardcoding, parametrize this better for the different environments
    const configToml = TOML.parse(readFileSync("config/public_umccr.toml").toString());
    //console.log(configToml);
    return {
      environment: env,
      htsgetConfig: HtsgetLambdaStack.configToEnv(configToml),
      allowCredentials:
        configToml.ticket_server_cors_allow_credentials as boolean,
      allowHeaders: HtsgetLambdaStack.convertCors(
        configToml,
        "ticket_server_cors_allow_headers"
      ),
      allowMethods: HtsgetLambdaStack.corsAllowMethodToHttpMethod(
        HtsgetLambdaStack.convertCors(
          configToml,
          "ticket_server_cors_allow_methods"
        )
      ),
      allowOrigins: HtsgetLambdaStack.convertCors(
        configToml,
        "ticket_server_cors_allow_origins"
      ),
      domain: configToml.domain.toString(),
      exposeHeaders: HtsgetLambdaStack.convertCors(
        configToml,
        "ticket_server_cors_expose_headers"
      ),
      authRequired: configToml.auth_required as boolean,
      maxAge:
        configToml.ticket_server_cors_max_age !== undefined
          ? Duration.seconds(configToml.ticket_server_cors_max_age as number)
          : undefined,
    };
  }
}
