// Sets the bucket CORS rule that browser uploads and downloads need, using the S3
// settings in .env. Works for Backblaze B2, Cloudflare R2, AWS S3 and other
// S3-compatible stores. No AWS CLI needed.
//
//   npm run storage:cors                                   allow the origins in APP_ORIGINS
//   npm run storage:cors -- https://my-app.pages.dev       allow extra origins too

import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const s3cfg = config.storage.s3;
if (config.storage.driver !== 's3' || !s3cfg) {
  console.error('This script is for STORAGE_DRIVER=s3 (Backblaze B2, R2, AWS S3 ...). Check your .env.');
  process.exit(1);
}

const origins = [...new Set([...config.auth.appOrigins, ...process.argv.slice(2).map((o) => o.replace(/\/$/, ''))])];
const client = new S3Client({
  region: s3cfg.region,
  endpoint: s3cfg.endpoint || undefined,
  forcePathStyle: s3cfg.forcePathStyle,
  credentials: { accessKeyId: s3cfg.accessKeyId, secretAccessKey: s3cfg.secretAccessKey },
});

const rule = {
  AllowedOrigins: origins,
  AllowedMethods: ['PUT', 'GET', 'HEAD'],
  AllowedHeaders: ['*'],
  ExposeHeaders: ['ETag'], // the browser needs each part's ETag to finish a multipart upload
  MaxAgeSeconds: 3600,
};

try {
  await client.send(new PutBucketCorsCommand({ Bucket: s3cfg.bucket, CORSConfiguration: { CORSRules: [rule] } }));
  const now = await client.send(new GetBucketCorsCommand({ Bucket: s3cfg.bucket }));
  console.log(`CORS set on bucket "${s3cfg.bucket}":`);
  console.log(JSON.stringify(now.CORSRules, null, 2));
} catch (err) {
  console.error(`Could not set CORS on "${s3cfg.bucket}": ${err.name}: ${err.message}`);
  console.error('Check S3_ENDPOINT, S3_REGION, S3_BUCKET and that the key is allowed to change bucket settings.');
  process.exit(1);
}