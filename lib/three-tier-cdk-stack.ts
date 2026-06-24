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

    // ============ NEW VPC WITH PUBLIC AND PRIVATE SUBNETS ============
    const newVpc = new ec2.Vpc(this, 'NewVpc', {
      cidr: '10.1.0.0/16',
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'PublicSubnet',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'PrivateSubnet',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // Security group for new VPC instance
    const newInstanceSg = new ec2.SecurityGroup(this, 'NewInstanceSg', {
      vpc: newVpc,
      allowAllOutbound: true,
      description: 'Security group for EC2 instance in new VPC',
    });
    newInstanceSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow SSH from anywhere'
    );
    newInstanceSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP from anywhere'
    );
    newInstanceSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from anywhere'
    );
    newInstanceSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8080),
      'Allow Jenkins from anywhere'
    );

    // IAM role for new instance (SSM access)
    const newInstanceRole = new iam.Role(this, 'NewInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    newInstanceRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );

    // Get public subnets for the new VPC
    const publicSubnets = newVpc.publicSubnets;

    // Launch EC2 instance in public subnet
    const newInstance = new ec2.Instance(this, 'PublicInstance', {
      vpc: newVpc,
      vpcSubnets: {
        subnets: [publicSubnets[0]], // Deploy in first public subnet (AZ1)
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      securityGroup: newInstanceSg,
      role: newInstanceRole,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    // User data for the new instance
    const newUserData = ec2.UserData.forLinux();
    newUserData.addCommands(
      'set -eux',
      'yum -y update',
      // Install Git
      'yum -y install git',
      // Install JDK 21
      'yum -y install java-21-amazon-corretto-devel',
      // Set JAVA_HOME
      'echo "export JAVA_HOME=/usr/lib/jvm/java-21-amazon-corretto" >> /etc/profile.d/java.sh',
      'source /etc/profile.d/java.sh',
      // Install Jenkins
      'wget -O /etc/yum.repos.d/jenkins.repo https://pkg.jenkins.io/redhat-stable/jenkins.repo',
      'rpm --import https://pkg.jenkins.io/redhat-stable/jenkins.io.key',
      'yum -y upgrade',
      'yum -y install jenkins',
      // Start Jenkins
      'systemctl daemon-reload',
      'systemctl enable jenkins',
      'systemctl start jenkins',
      // Install Nginx for reverse proxy
      'yum -y install nginx',
      // Get instance metadata
      'INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)',
      'INSTANCE_AZ=$(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone)',
      'PRIVATE_IP=$(curl -s http://169.254.169.254/latest/meta-data/local-ipv4)',
      `echo "<h1>Jenkins Instance</h1><p>Instance ID: $INSTANCE_ID</p><p>AZ: $INSTANCE_AZ</p><p>Private IP: $PRIVATE_IP</p><p>Jenkins running on port 8080</p><p>Git version: $(git --version)</p><p>Java version: $(java -version 2>&1 | head -1)</p>" > /usr/share/nginx/html/index.html`,
      'systemctl enable nginx',
      'systemctl start nginx'
    );
    newInstance.addUserData(newUserData.render());

    // Outputs
    new cdk.CfnOutput(this, 'AlbDns', { value: `http://${alb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'DbEndpoint', { value: db.instanceEndpoint.hostname });
    if (db.secret) new cdk.CfnOutput(this, 'DbSecretName', { value: db.secret.secretName });

    // New VPC Outputs
    new cdk.CfnOutput(this, 'NewVpcId', { value: newVpc.vpcId });
    new cdk.CfnOutput(this, 'NewPublicSubnet1', {
      value: publicSubnets[0].subnetId,
      description: 'First Public Subnet (AZ1)',
    });
    new cdk.CfnOutput(this, 'NewPublicSubnet2', {
      value: publicSubnets[1].subnetId,
      description: 'Second Public Subnet (AZ2)',
    });
    new cdk.CfnOutput(this, 'NewInstanceId', {
      value: newInstance.instanceId,
      description: 'EC2 Instance ID in public subnet',
    });
    new cdk.CfnOutput(this, 'NewInstancePublicIp', {
      value: newInstance.instancePublicIp || 'N/A',
      description: 'Public IP of the new instance',
    });
  }
}

