// ============================================================
// Adaptador de armazenamento de arquivos: expõe uma interface
// compatível com o binding R2Bucket do Cloudflare Workers
// (put/get), implementada sobre o SDK S3 — usado para continuar
// usando o Cloudflare R2 (API S3-compatível) a partir de um
// servidor Node.js hospedado na Hostinger, onde o disco local
// é efêmero (apagado a cada deploy).
// ============================================================

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'

export interface AppStorageObject {
  // Sempre um ReadableStream Web-standard, para permanecer compatível com
  // `new Response(object.body, ...)` usado nas rotas (projetos/publico),
  // sem precisar reescrevê-las ao migrar do R2 nativo para S3/Node.
  body: ReadableStream | null
  httpMetadata?: { contentType?: string }
}

export interface AppStoragePutOptions {
  httpMetadata?: { contentType?: string }
}

export interface AppBucket {
  put(key: string, value: ArrayBuffer | Uint8Array | Buffer, options?: AppStoragePutOptions): Promise<void>
  get(key: string): Promise<AppStorageObject | null>
  delete(key: string): Promise<void>
}

let client: S3Client | null = null

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT, // ex: https://<account_id>.r2.cloudflarestorage.com
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || ''
      }
    })
  }
  return client
}

export function createBucket(bucketName: string): AppBucket {
  return {
    async put(key, value, options) {
      const s3 = getClient()
      const body = value instanceof Buffer ? value : Buffer.from(value as ArrayBuffer)
      await s3.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: body,
          ContentType: options?.httpMetadata?.contentType
        })
      )
    },
    async get(key) {
      const s3 = getClient()
      try {
        const result = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }))
        const nodeStream = result.Body as unknown as Readable
        // Converte o stream Node (Readable) em um ReadableStream Web-standard,
        // para ser aceito diretamente por `new Response(body, ...)`.
        const webStream = (Readable.toWeb
          ? Readable.toWeb(nodeStream)
          : nodeStream) as unknown as ReadableStream
        return {
          body: webStream,
          httpMetadata: { contentType: result.ContentType }
        }
      } catch (err: any) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
          return null
        }
        throw err
      }
    },
    async delete(key) {
      const s3 = getClient()
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }))
    }
  }
}

export function getStorage(): AppBucket {
  return createBucket(process.env.R2_BUCKET_NAME || '')
}
