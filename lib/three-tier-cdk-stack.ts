import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';

export class ThreeTierCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ============ CONSOLIDATED VPC ============
    // Single VPC: 10.0.0.0/16
    // Public (Jenkins): 10.0.1.0/24, 10.0.2.0/24
    // Private: 10.0.11.0/24, 10.0.12.0/24
    // Isolated: 10.0.21.0/24, 10.0.22.0/24
    const vpc = new ec2.Vpc(this, 'Vpc', {
      cidr: '10.0.0.0/16',
      maxAzs: 2,
      natGateways: 1, // One NAT GW for private subnets (AZ1)
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
          reserved: false,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
          reserved: false,
        },
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
          reserved: false,
        },
      ],
    });

    // ============ JENKINS INSTANCE IN PUBLIC SUBNET ============
    // Security group for Jenkins instance
    const jenkinsInstanceSg = new ec2.SecurityGroup(this, 'JenkinsInstanceSg', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for Jenkins instance',
    });
    // Allow HTTP from anywhere
    jenkinsInstanceSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP from anywhere'
    );
    // Allow HTTPS from anywhere
    jenkinsInstanceSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from anywhere'
    );
    // Allow Jenkins only from your IP (UPDATE THIS WITH YOUR IP ADDRESS)
    const yourIpAddress = '0.0.0.0/0'; // TODO: Replace with your IP in format 'YOUR_IP/32'
    jenkinsInstanceSg.addIngressRule(
      ec2.Peer.ipv4(yourIpAddress),
      ec2.Port.tcp(8080),
      'Allow Jenkins from your IP'
    );

    // IAM role for Jenkins instance (SSM access)
    const jenkinsInstanceRole = new iam.Role(this, 'JenkinsInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    jenkinsInstanceRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );

    // Get public subnets
    const publicSubnets = vpc.publicSubnets;

    // Launch Jenkins instance in PUBLIC subnet (AZ1) - without user data
    const jenkinsInstance = new ec2.Instance(this, 'JenkinsInstance', {
      vpc,
      vpcSubnets: {
        subnets: [publicSubnets[0]], // Deploy in first public subnet (AZ1)
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      securityGroup: jenkinsInstanceSg,
      role: jenkinsInstanceRole,
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

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'JenkinsInstanceId', {
      value: jenkinsInstance.instanceId,
      description: 'EC2 Instance ID for Jenkins',
    });
    new cdk.CfnOutput(this, 'JenkinsInstancePublicIp', {
      value: jenkinsInstance.instancePublicIp || 'N/A',
      description: 'Public IP of Jenkins instance',
    });
  }
}

