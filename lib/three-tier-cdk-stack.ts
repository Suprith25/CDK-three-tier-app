import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';

export class ThreeTierCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC: 2 AZs, no NAT GW (save cost)
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // SGs
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, allowAllOutbound: true });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from internet');

    const webSg = new ec2.SecurityGroup(this, 'WebSg', { vpc, allowAllOutbound: true });
    webSg.addIngressRule(albSg, ec2.Port.tcp(80), 'ALB to web on 80');

    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc, allowAllOutbound: true });
    dbSg.addIngressRule(webSg, ec2.Port.tcp(3306), 'Web to DB MySQL');

    // RDS MySQL
    const db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0_39, // if not available, pick closest 8.0.x in your lib
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      multiAz: false,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      securityGroups: [dbSg],
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // demo only
      publiclyAccessible: false,
      databaseName: 'appdb',
      credentials: rds.Credentials.fromGeneratedSecret('admin'),
    });

    // EC2 role (SSM)
    const webRole = new iam.Role(this, 'WebRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    webRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );
    if (db.secret) db.secret.grantRead(webRole);

    // User data (Nginx + info page)
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -eux',
      'dnf -y update || yum -y update',
      'dnf -y install nginx || yum -y install nginx',
      'INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)',
      `echo "<h1>Three-tier demo</h1><p>Instance: $INSTANCE_ID</p><p>DB endpoint: ${db.instanceEndpoint.hostname}:3306</p>" > /usr/share/nginx/html/index.html`,
      'systemctl enable nginx',
      'systemctl start nginx'
    );

    // ASG with 2 web servers
    const asg = new autoscaling.AutoScalingGroup(this, 'Asg', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, // avoid NAT cost
      instanceType: new ec2.InstanceType('t3.micro'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      minCapacity: 2,
      maxCapacity: 2,
      desiredCapacity: 2,
      securityGroup: webSg,
      role: webRole,
      userData,
    });

    // ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener('HttpListener', { port: 80, open: false });
    listener.addTargets('AsgTargets', {
      port: 80,
      targets: [asg],
      healthCheck: { path: '/', interval: cdk.Duration.seconds(30) },
    });

    // Outputs
    new cdk.CfnOutput(this, 'AlbDns', { value: `http://${alb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'DbEndpoint', { value: db.instanceEndpoint.hostname });
    if (db.secret) new cdk.CfnOutput(this, 'DbSecretName', { value: db.secret.secretName });
  }
}

