import { createHash, randomUUID } from 'node:crypto';
import config from './config.mjs';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CLOUDINARY_FOLDER = 'iwacumall/products';

export function cloudinaryUploadEnabled() {
  return Boolean(config.cloudinaryCloudName && config.cloudinaryApiKey && config.cloudinaryApiSecret);
}

function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 12 * 1024 * 1024) {
    throw Object.assign(new Error('Choose a product photo smaller than 8 MB.'), { status: 400 });
  }
  const match = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw Object.assign(new Error('Use a PNG, JPG or WebP product image.'), { status: 400 });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('Choose a product photo smaller than 8 MB.'), { status: 413 });
  }

  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp = buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!(isPng || isJpeg || isWebp)) {
    throw Object.assign(new Error('The selected file is not a valid PNG, JPG or WebP image.'), { status: 400 });
  }
  const mimeType = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : 'image/webp';
  return { buffer, mimeType };
}

/** Upload an admin-selected raster image to durable Cloudinary storage. */
export async function uploadProductImage(dataUrl) {
  if (!cloudinaryUploadEnabled()) {
    throw Object.assign(new Error('Product image storage is not configured.'), { status: 503 });
  }
  const { buffer, mimeType } = decodeImageDataUrl(dataUrl);
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `${CLOUDINARY_FOLDER}/${randomUUID()}`;
  const signedParams = `public_id=${publicId}&timestamp=${timestamp}`;
  const signature = createHash('sha1')
    .update(`${signedParams}${config.cloudinaryApiSecret}`)
    .digest('hex');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), `${publicId.split('/').pop()}.${mimeType.split('/')[1]}`);
  form.append('api_key', config.cloudinaryApiKey);
  form.append('timestamp', String(timestamp));
  form.append('public_id', publicId);
  form.append('signature', signature);

  let response;
  try {
    response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudinaryCloudName)}/image/upload`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw Object.assign(new Error('The image storage service could not be reached. Try again.'), { status: 502 });
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || typeof result?.secure_url !== 'string' || !result.secure_url.startsWith('https://res.cloudinary.com/')) {
    throw Object.assign(new Error('Image storage rejected this upload. Check the Cloudinary configuration and try again.'), { status: 502 });
  }
  return { secureUrl: result.secure_url, publicId: result.public_id };
}

/** Delete only assets created inside this application's product folder. */
export async function deleteProductImage(publicId) {
  if (typeof publicId !== 'string' || !/^iwacumall\/products\/[0-9a-f-]{36}$/i.test(publicId)) {
    throw Object.assign(new Error('Invalid product image identifier.'), { status: 400 });
  }
  if (!cloudinaryUploadEnabled()) {
    throw Object.assign(new Error('Product image storage is not configured.'), { status: 503 });
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const signedParams = `invalidate=true&public_id=${publicId}&timestamp=${timestamp}`;
  const signature = createHash('sha1')
    .update(`${signedParams}${config.cloudinaryApiSecret}`)
    .digest('hex');
  const form = new FormData();
  form.append('public_id', publicId);
  form.append('api_key', config.cloudinaryApiKey);
  form.append('timestamp', String(timestamp));
  form.append('invalidate', 'true');
  form.append('signature', signature);

  let response;
  try {
    response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudinaryCloudName)}/image/destroy`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw Object.assign(new Error('The image storage service could not be reached.'), { status: 502 });
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !['ok', 'not found'].includes(result?.result)) {
    throw Object.assign(new Error('Image storage could not remove the previous product photo.'), { status: 502 });
  }
  return true;
}
