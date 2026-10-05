const { apiError } = require('./gemini');
function validatePhotoUrl(value) {
  if (!value) return null;
  let url; try { url = new URL(value); } catch { throw apiError(400, 'Invalid Cloudinary photo URL.'); }
  const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'dohhfubsa';
  if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com' || url.port || url.username || url.password || !url.pathname.startsWith(`/${cloud}/image/upload/`)) throw apiError(400, 'Photo must be an image uploaded to your configured Cloudinary cloud.');
  return url;
}
async function loadPhoto(value) {
  const url = validatePhotoUrl(value); if (!url) return undefined;
  url.pathname = url.pathname.replace('/image/upload/', '/image/upload/f_jpg,c_fill,w_300,h_360,q_85/'); url.search = ''; url.hash = '';
  let response; try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12000) }); } catch { throw apiError(502, 'Could not load the CV photo. Retry or remove it.'); }
  if (!response.ok || !/^image\/(jpeg|png)/.test(response.headers.get('content-type') || '')) throw apiError(400, 'Cloudinary photo is unavailable or is not a supported image.');
  if (Number(response.headers.get('content-length')) > 5 * 1024 * 1024) throw apiError(400, 'Photo is too large.');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try { while (true) { const { done, value: chunk } = await reader.read(); if (done) break; length += chunk.length; if (length > 5 * 1024 * 1024) { await reader.cancel(); throw apiError(400, 'Photo is too large.'); } chunks.push(Buffer.from(chunk)); } }
  catch (error) { throw error.status ? error : apiError(502, 'Photo download failed. Retry or remove the photo.'); }
  return Buffer.concat(chunks);
}
module.exports = { validatePhotoUrl, loadPhoto };
