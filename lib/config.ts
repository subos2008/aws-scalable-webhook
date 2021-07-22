export interface Config {
  readonly awsAccount: string;
  readonly awsRegion: string;

  readonly environment: string;
  readonly service: string;

  readonly domain: string;
  readonly subdomain: string;
  readonly acmCertificateArn: string;
  // readonly forwarderArn: string;
  readonly sentryDsn: string;

  readonly create_faux_backend: boolean;
  readonly backend_url: string;
}
