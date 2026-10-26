'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const execFile = promisify(childProcess.execFile);

const SCHEME = 'microfiche-reel';
const SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const LIMITS = Object.freeze({
  maxPages: 500,
  maxPdfBytes: 500 * 1024 * 1024,
  maxImageBytes: 100 * 1024 * 1024,
  maxImageInputBytes: 1024 * 1024 * 1024,
  maxPageOutputBytes: 128 * 1024 * 1024,
  maxOutputBytes: 5 * 1024 * 1024 * 1024,
  freeSpaceReserveBytes: 1024 * 1024 * 1024,
  maxDimension: 16_384,
  maxPixels: 60_000_000,
  normalizedLongEdge: 6_000,
  maxOcrPageChars: 100_000,
  maxOcrIssueChars: 10_000_000,
});

const TOOLS = Object.freeze({
  bwrap: '/usr/bin/bwrap',
  magick: '/usr/bin/magick',
  pdfinfo: '/usr/bin/pdfinfo',
  pdftoppm: '/usr/bin/pdftoppm',
  pdftotext: '/usr/bin/pdftotext',
  prlimit: '/usr/bin/prlimit',
});

const FIELD_LIMITS = Object.freeze({
  publication: 200,
  issueDate: 10,
  edition: 120,
  location: 200,
  sourceLabel: 200,
  rights: 500,
  sourceUrl: 2048,
});

const METADATA_FIELDS = new Set(Object.keys(FIELD_LIMITS));
const naturalCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
  usage: 'sort',
});

class IssueReelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IssueReelError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new IssueReelError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanText(value, field, required = false) {
  if (value === undefined || value === null) {
    if (required) fail('INVALID_METADATA', `${field} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') fail('INVALID_METADATA', `${field} must be text.`);
  const normalized = value.normalize('NFC').trim();
  if (required && !normalized) fail('INVALID_METADATA', `${field} is required.`);
  if (!normalized) return undefined;
  if (normalized.length > FIELD_LIMITS[field] || CONTROL_OR_BIDI.test(normalized)) {
    fail('INVALID_METADATA', `${field} is invalid.`);
  }
  return normalized;
}

function validateIsoDate(value) {
  const date = cleanText(value, 'issueDate', true);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) fail('INVALID_METADATA', 'issueDate must use YYYY-MM-DD.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (year < 1000 || year > 9999 || day < 1 || day > daysInMonth) {
    fail('INVALID_METADATA', 'issueDate is not a real calendar date.');
  }
  return date;
}

function validateSourceUrl(value) {
  const sourceUrl = cleanText(value, 'sourceUrl');
  if (!sourceUrl) return undefined;
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    fail('INVALID_METADATA', 'sourceUrl must be a valid web address.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    fail('INVALID_METADATA', 'sourceUrl must be an HTTPS address without credentials.');
  }
  return parsed.href;
}

function validateMetadata(input) {
  if (!isPlainObject(input)) fail('INVALID_METADATA', 'Issue metadata must be an object.');
  for (const key of Object.keys(input)) {
    if (!METADATA_FIELDS.has(key)) fail('INVALID_METADATA', `Unknown metadata field: ${key}`);
  }
  return Object.freeze({
    publication: cleanText(input.publication, 'publication', true),
    issueDate: validateIsoDate(input.issueDate),
    ...(cleanText(input.edition, 'edition') ? { edition: cleanText(input.edition, 'edition') } : {}),
    ...(cleanText(input.location, 'location') ? { location: cleanText(input.location, 'location') } : {}),
    ...(cleanText(input.sourceLabel, 'sourceLabel') ? { sourceLabel: cleanText(input.sourceLabel, 'sourceLabel') } : {}),
    ...(cleanText(input.rights, 'rights') ? { rights: cleanText(input.rights, 'rights') } : {}),
    ...(validateSourceUrl(input.sourceUrl) ? { sourceUrl: validateSourceUrl(input.sourceUrl) } : {}),
  });
}

function detectMagic(header) {
  if (!Buffer.isBuffer(header)) return null;
  if (header.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return 'pdf';
  if (header.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'png';
  if (header.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'jpeg';
  return null;
}

function extensionType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (extension === '.png') return 'png';
  if (extension === '.jpg' || extension === '.jpeg') return 'jpeg';
  return null;
}

function naturalPathCompare(left, right) {
  const byName = naturalCollator.compare(path.basename(left), path.basename(right));
  return byName || naturalCollator.compare(left, right);
}

function validateSelection(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0 || filePaths.length > LIMITS.maxPages) {
    fail('INVALID_SELECTION', `Choose one PDF or up to ${LIMITS.maxPages} JPEG/PNG pages.`);
  }
  const selected = filePaths.map((filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
      fail('INVALID_SELECTION', 'The selected file list is invalid.');
    }
    const type = extensionType(filePath);
    if (!type) fail('UNSUPPORTED_FORMAT', 'Only PDF, JPEG, and PNG files are supported.');
    return { sourcePath: filePath, expectedType: type };
  });
  const pdfCount = selected.filter((entry) => entry.expectedType === 'pdf').length;
  if (pdfCount && (pdfCount !== 1 || selected.length !== 1)) {
    fail('INVALID_SELECTION', 'Choose one PDF or an ordered group of images, not both.');
  }
  return pdfCount ? selected : selected.sort((a, b) => naturalPathCompare(a.sourcePath, b.sourcePath));
}

function parsePdfInfo(output) {
  if (typeof output !== 'string') fail('CORRUPT_DOCUMENT', 'The PDF could not be inspected.');
  const pagesMatch = /^Pages:\s*(\d+)\s*$/im.exec(output);
  if (!pagesMatch) fail('CORRUPT_DOCUMENT', 'The PDF does not report a page count.');
  const pages = Number(pagesMatch[1]);
  if (!Number.isSafeInteger(pages) || pages < 1) fail('CORRUPT_DOCUMENT', 'The PDF has no readable pages.');
  if (pages > LIMITS.maxPages) fail('TOO_MANY_PAGES', `The PDF exceeds ${LIMITS.maxPages} pages.`);
  const encrypted = /^Encrypted:\s*yes(?:\s|$)/im.test(output);
  if (encrypted) fail('ENCRYPTED_PDF', 'Encrypted PDFs cannot be imported.');
  return { pages, encrypted: false };
}

function createAssetUrl(id, kind, pageNumber) {
  if (!UUID_PATTERN.test(id) || !['page', 'thumb'].includes(kind)
      || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > LIMITS.maxPages) {
    fail('INVALID_ASSET', 'Invalid reel asset identifier.');
  }
  return `${SCHEME}://asset/issue/${id.toLowerCase()}/${kind}/${pageNumber}`;
}

function parseAssetUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${SCHEME}:` || parsed.hostname !== 'asset' || parsed.port
      || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const match = /^\/issue\/([0-9a-f-]{36})\/(page|thumb)\/([1-9]\d{0,2})$/.exec(parsed.pathname);
  if (!match || !UUID_PATTERN.test(match[1])) return null;
  const pageNumber = Number(match[3]);
  if (!Number.isSafeInteger(pageNumber) || pageNumber > LIMITS.maxPages) return null;
  return Object.freeze({ id: match[1].toLowerCase(), kind: match[2], pageNumber });
}

function sanitizeExtractedText(value, remainingChars = LIMITS.maxOcrPageChars) {
  if (typeof value !== 'string' || remainingChars <= 0) return '';
  return value
    .normalize('NFC')
    .replace(/[\u0000\u0008\u000b\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, Math.min(LIMITS.maxOcrPageChars, remainingChars));
}

function progressEmitter(callback) {
  return (stage, message, current, total) => {
    if (typeof callback !== 'function') return;
    const event = { stage, message };
    if (Number.isSafeInteger(current) && current >= 0) event.current = current;
    if (Number.isSafeInteger(total) && total >= 0) event.total = total;
    try {
      callback(Object.freeze(event));
    } catch {
      // UI progress observers never control or interrupt the trusted import.
    }
  };
}

function publicSummary(manifest) {
  return Object.freeze({
    id: manifest.id,
    publication: manifest.metadata.publication,
    issueDate: manifest.metadata.issueDate,
    pageCount: manifest.pageCount,
    ...(manifest.metadata.edition ? { edition: manifest.metadata.edition } : {}),
    ...(manifest.metadata.location ? { location: manifest.metadata.location } : {}),
    ...(manifest.metadata.sourceLabel ? { sourceLabel: manifest.metadata.sourceLabel } : {}),
    ...(manifest.metadata.rights ? { rights: manifest.metadata.rights } : {}),
    ...(manifest.metadata.sourceUrl ? { sourceUrl: manifest.metadata.sourceUrl } : {}),
    importedAt: manifest.importedAt,
  });
}

function publicReel(manifest) {
  return Object.freeze({
    ...publicSummary(manifest),
    pages: Object.freeze(manifest.pages.map((entry) => Object.freeze({
      number: entry.number,
      page: entry.number,
      frame: String(entry.number).padStart(4, '0'),
      imageUrl: createAssetUrl(manifest.id, 'page', entry.number),
      thumbnailUrl: createAssetUrl(manifest.id, 'thumb', entry.number),
      ...(entry.ocrText ? { ocrText: entry.ocrText } : {}),
      textSource: entry.textSource,
      sha256: entry.sha256,
      width: entry.width,
      height: entry.height,
    }))),
  });
}

function assertSafeRelativeAsset(fileName, kind, number) {
  const expected = kind === 'page'
    ? `pages/page-${String(number).padStart(4, '0')}.jpg`
    : `thumbs/page-${String(number).padStart(4, '0')}.jpg`;
  if (fileName !== expected) fail('CORRUPT_DOCUMENT', 'The reel manifest contains an invalid asset.');
  return expected;
}

function validateManifest(input, expectedId) {
  if (!isPlainObject(input) || input.schemaVersion !== SCHEMA_VERSION
      || typeof input.id !== 'string' || !UUID_PATTERN.test(input.id)
      || input.id.toLowerCase() !== expectedId.toLowerCase()) {
    fail('CORRUPT_DOCUMENT', 'The reel manifest is invalid.');
  }
  const metadata = validateMetadata(input.metadata);
  if (typeof input.importedAt !== 'string' || Number.isNaN(Date.parse(input.importedAt))) {
    fail('CORRUPT_DOCUMENT', 'The reel import timestamp is invalid.');
  }
  if (!Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > LIMITS.maxPages
      || input.pageCount !== input.pages.length) {
    fail('CORRUPT_DOCUMENT', 'The reel page list is invalid.');
  }
  const pages = input.pages.map((entry, index) => {
    const number = index + 1;
    if (!isPlainObject(entry) || entry.number !== number
        || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)
        || !Number.isSafeInteger(entry.width) || entry.width < 1 || entry.width > LIMITS.normalizedLongEdge
        || !Number.isSafeInteger(entry.height) || entry.height < 1 || entry.height > LIMITS.normalizedLongEdge
        || !['embedded', 'none'].includes(entry.textSource)
        || (entry.ocrText !== undefined && typeof entry.ocrText !== 'string')) {
      fail('CORRUPT_DOCUMENT', 'A reel page record is invalid.');
    }
    return {
      number,
      imageFile: assertSafeRelativeAsset(entry.imageFile, 'page', number),
      thumbnailFile: assertSafeRelativeAsset(entry.thumbnailFile, 'thumb', number),
      sha256: entry.sha256,
      width: entry.width,
      height: entry.height,
      textSource: entry.textSource,
      ...(entry.ocrText ? { ocrText: sanitizeExtractedText(entry.ocrText) } : {}),
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    id: input.id.toLowerCase(),
    metadata,
    importedAt: input.importedAt,
    pageCount: pages.length,
    pages,
  };
}

function jpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 3).equals(JPEG_MAGIC)) return null;
  let offset = 2;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 9 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (sofMarkers.has(marker) && length >= 7) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hostArgs(args, workspace) {
  return args.map((argument) => {
    if (argument === '/work') return workspace;
    if (argument.startsWith('/work/')) {
      const relative = argument.slice('/work/'.length);
      const resolved = path.resolve(workspace, relative);
      if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) {
        fail('CONVERSION_FAILED', 'A conversion path escaped the import workspace.');
      }
      return resolved;
    }
    return argument;
  });
}

function looksLikeUnavailableBwrap(error) {
  if (error && ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return true;
  const stderr = String(error && error.stderr ? error.stderr : '');
  return /bwrap:.*(?:operation not permitted|permission denied|user namespace|namespace failed|not supported)/i.test(stderr);
}

async function runConstrainedTool(tool, args, options) {
  const {
    workspace,
    timeout = 5 * 60 * 1000,
    maxBuffer = 4 * 1024 * 1024,
    allowSandboxFallback = false,
  } = options;
  if (!Object.values(TOOLS).includes(tool) || !Array.isArray(args)) {
    fail('CONVERSION_FAILED', 'An unapproved conversion command was rejected.');
  }
  const hasPrlimit = await pathExists(TOOLS.prlimit);
  if (!hasPrlimit || !(await pathExists(tool))) {
    fail('CONVERSION_FAILED', 'A required local conversion tool is unavailable.');
  }
  const limits = [
    '--as=1610612736',
    `--fsize=${LIMITS.maxPageOutputBytes}`,
    '--nofile=128',
    '--cpu=900',
    '--',
  ];
  const environment = {
    HOME: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin',
    MAGICK_TMPDIR: path.join(workspace, 'tmp'),
    MAGICK_THREAD_LIMIT: '4',
  };
  const common = {
    cwd: workspace,
    env: environment,
    encoding: 'utf8',
    timeout,
    maxBuffer,
    windowsHide: true,
    shell: false,
  };

  if (await pathExists(TOOLS.bwrap)) {
    const bwrapArgs = [
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--clearenv',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/etc/alternatives/magick', '/etc/alternatives/magick',
      '--ro-bind-try', '/etc/fonts', '/etc/fonts',
      '--ro-bind-try', '/etc/ImageMagick-6', '/etc/ImageMagick-6',
      '--ro-bind-try', '/etc/ImageMagick-7', '/etc/ImageMagick-7',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--bind', workspace, '/work',
      '--chdir', '/work',
      '--setenv', 'HOME', '/tmp',
      '--setenv', 'LANG', 'C.UTF-8',
      '--setenv', 'LC_ALL', 'C.UTF-8',
      '--setenv', 'PATH', '/usr/bin:/bin',
      '--setenv', 'MAGICK_TMPDIR', '/tmp',
      '--setenv', 'MAGICK_THREAD_LIMIT', '4',
      '--', tool, ...args,
    ];
    try {
      return await execFile(TOOLS.prlimit, [...limits, TOOLS.bwrap, ...bwrapArgs], common);
    } catch (error) {
      if (!allowSandboxFallback || !looksLikeUnavailableBwrap(error)) throw error;
      // Explicit fallback: fixed executable/argv, resource limits, clean environment,
      // immutable staged inputs, and a private cwd remain enforced. This exists only
      // for Linux builds where unprivileged user namespaces disable bubblewrap.
    }
  }

  if (!allowSandboxFallback) {
    fail('CONVERSION_FAILED', 'The secure conversion sandbox is unavailable.');
  }

  return execFile(
    TOOLS.prlimit,
    [...limits, tool, ...hostArgs(args, workspace)],
    { ...common, env: { ...environment, HOME: path.join(workspace, 'tmp') } },
  );
}

async function copyTrustedInput(source, destination, maxBytes) {
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await fsp.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await sourceHandle.stat();
    if (!stat.isFile()) fail('INVALID_SELECTION', 'Only regular files can be imported.');
    if (stat.size < 1 || stat.size > maxBytes) fail('FILE_TOO_LARGE', 'A selected file exceeds the import limit.');
    destinationHandle = await fsp.open(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < stat.size) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytesRead) fail('INVALID_SELECTION', 'A selected file changed during import.');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await destinationHandle.write(chunk, 0, bytesRead, position);
      position += bytesRead;
      if (position > maxBytes) fail('FILE_TOO_LARGE', 'A selected file exceeds the import limit.');
    }
    const finalStat = await sourceHandle.stat();
    if (finalStat.size !== stat.size || finalStat.mtimeMs !== stat.mtimeMs) {
      fail('INVALID_SELECTION', 'A selected file changed during import.');
    }
    await destinationHandle.sync();
    await destinationHandle.chmod(0o600);
    return { size: stat.size, sha256: hash.digest('hex') };
  } catch (error) {
    if (error instanceof IssueReelError) throw error;
    if (error && error.code === 'ELOOP') fail('INVALID_SELECTION', 'Symbolic links cannot be imported.');
    if (error && error.code === 'ENOSPC') fail('STORAGE_FULL', 'There is not enough local storage for this reel.');
    fail('INVALID_SELECTION', 'A selected file could not be read safely.');
  } finally {
    await destinationHandle?.close().catch(() => {});
    await sourceHandle?.close().catch(() => {});
  }
}

async function readHeader(filePath, count = 16) {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function hashAndInspectJpeg(filePath) {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > LIMITS.maxPageOutputBytes) {
      fail('CONVERSION_FAILED', 'A normalized page exceeded the safe output limit.');
    }
    const data = await handle.readFile();
    const dimensions = jpegDimensions(data);
    if (!dimensions || dimensions.width > LIMITS.normalizedLongEdge
        || dimensions.height > LIMITS.normalizedLongEdge
        || dimensions.width * dimensions.height > LIMITS.maxPixels) {
      fail('CONVERSION_FAILED', 'A normalized page has unsafe dimensions.');
    }
    return {
      ...dimensions,
      byteLength: stat.size,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

async function ensureFreeSpace(directory, requestedBytes = 0) {
  if (typeof fsp.statfs !== 'function') return;
  const stat = await fsp.statfs(directory);
  const available = Number(stat.bavail) * Number(stat.bsize);
  const required = LIMITS.freeSpaceReserveBytes + Math.min(requestedBytes * 2, LIMITS.maxOutputBytes);
  if (!Number.isFinite(available) || available < required) {
    fail('STORAGE_FULL', 'There is not enough local storage for this reel.');
  }
}

async function writeAtomicJson(directory, name, value) {
  const temporary = path.join(directory, `.${name}.${crypto.randomUUID()}.tmp`);
  const destination = path.join(directory, name);
  const handle = await fsp.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, destination);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, fs.constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some filesystems do not permit directory fsync; the file itself is synced.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function normalizePage(workspace, inputRelative, outputRelative, allowSandboxFallback = false) {
  await runConstrainedTool(TOOLS.magick, [
    '-limit', 'memory', '256MiB',
    '-limit', 'map', '512MiB',
    '-limit', 'disk', '2GiB',
    '-limit', 'thread', '4',
    '-limit', 'width', String(LIMITS.maxDimension),
    '-limit', 'height', String(LIMITS.maxDimension),
    '-limit', 'area', String(LIMITS.maxPixels),
    `/work/${inputRelative}`,
    '-auto-orient',
    '-strip',
    '-background', '#f4ecd8',
    '-alpha', 'remove',
    '-alpha', 'off',
    '-colorspace', 'sRGB',
    '-resize', `${LIMITS.normalizedLongEdge}x${LIMITS.normalizedLongEdge}>`,
    '-sampling-factor', '4:2:0',
    '-interlace', 'Plane',
    '-quality', '88',
    `/work/${outputRelative}`,
  ], { workspace, timeout: 5 * 60 * 1000, allowSandboxFallback });
}

async function makeThumbnail(workspace, inputRelative, outputRelative, allowSandboxFallback = false) {
  await runConstrainedTool(TOOLS.magick, [
    '-limit', 'memory', '128MiB',
    '-limit', 'map', '256MiB',
    '-limit', 'disk', '512MiB',
    '-limit', 'thread', '4',
    `/work/${inputRelative}`,
    '-strip',
    '-resize', '360x360>',
    '-sampling-factor', '4:2:0',
    '-interlace', 'Plane',
    '-quality', '78',
    `/work/${outputRelative}`,
  ], { workspace, timeout: 2 * 60 * 1000, allowSandboxFallback });
}

async function extractPdfText(workspace, pageCount, allowSandboxFallback = false) {
  try {
    const result = await runConstrainedTool(
      TOOLS.pdftotext,
      ['-layout', '-enc', 'UTF-8', '/work/inputs/source.pdf', '-'],
      { workspace, timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, allowSandboxFallback },
    );
    const rawPages = String(result.stdout || '').split('\f');
    const pages = [];
    let remaining = LIMITS.maxOcrIssueChars;
    for (let index = 0; index < pageCount; index += 1) {
      const text = sanitizeExtractedText(rawPages[index] || '', remaining);
      pages.push(text);
      remaining -= text.length;
    }
    return pages;
  } catch {
    return Array(pageCount).fill('');
  }
}

function conversionFailure(error) {
  if (error instanceof IssueReelError) return error;
  if (error && error.code === 'ENOSPC') return new IssueReelError('STORAGE_FULL', 'There is not enough local storage for this reel.');
  return new IssueReelError('CONVERSION_FAILED', 'The selected issue could not be converted safely.');
}

class IssueReelStore {
  constructor(rootDirectory, allowSandboxFallbackForTests = false) {
    this.rootDirectory = rootDirectory;
    this.reelsDirectory = path.join(rootDirectory, 'reels');
    this.stagingDirectory = path.join(rootDirectory, '.staging');
    this.importActive = false;
    this.allowSandboxFallbackForTests = allowSandboxFallbackForTests === true;
  }

  async initialize() {
    await fsp.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.rootDirectory, 0o700);
    await fsp.mkdir(this.reelsDirectory, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.reelsDirectory, 0o700);
    await fsp.mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.stagingDirectory, 0o700);
    const stale = await fsp.readdir(this.stagingDirectory, { withFileTypes: true });
    for (const entry of stale) {
      if (entry.isDirectory() && UUID_PATTERN.test(entry.name.replace(/\.staging$/, ''))) {
        await fsp.rm(path.join(this.stagingDirectory, entry.name), { recursive: true, force: true }).catch(() => {});
      }
    }
    return this;
  }

  async readManifest(id) {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) fail('INVALID_REEL', 'Invalid reel identifier.');
    const normalizedId = id.toLowerCase();
    const manifestPath = path.join(this.reelsDirectory, normalizedId, 'manifest.json');
    let handle;
    try {
      handle = await fsp.open(manifestPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 2 || stat.size > 64 * 1024 * 1024) {
        fail('CORRUPT_DOCUMENT', 'The reel manifest is invalid.');
      }
      const raw = await handle.readFile('utf8');
      return validateManifest(JSON.parse(raw), normalizedId);
    } catch (error) {
      if (error instanceof IssueReelError) throw error;
      if (error && error.code === 'ENOENT') fail('REEL_NOT_FOUND', 'The requested reel does not exist.');
      fail('CORRUPT_DOCUMENT', 'The reel manifest could not be read.');
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async list() {
    const entries = await fsp.readdir(this.reelsDirectory, { withFileTypes: true });
    const reels = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      try {
        reels.push(publicSummary(await this.readManifest(entry.name)));
      } catch {
        // A damaged or manually-added directory is not exposed to the renderer.
      }
    }
    return reels.sort((left, right) => right.importedAt.localeCompare(left.importedAt));
  }

  async get(id) {
    return publicReel(await this.readManifest(id));
  }

  async importFiles({ metadata: metadataInput, filePaths, onProgress } = {}) {
    if (this.importActive) fail('IMPORT_BUSY', 'Another issue reel import is already running.');
    this.importActive = true;
    const emit = progressEmitter(onProgress);
    let stageDirectory;
    try {
      emit('validating', 'Checking the issue details and selected files.');
      const metadata = validateMetadata(metadataInput);
      const selection = validateSelection(filePaths);
      const id = crypto.randomUUID();
      stageDirectory = path.join(this.stagingDirectory, `${id}.staging`);
      const inputsDirectory = path.join(stageDirectory, 'inputs');
      const pagesDirectory = path.join(stageDirectory, 'pages');
      const thumbsDirectory = path.join(stageDirectory, 'thumbs');
      const renderDirectory = path.join(stageDirectory, 'render');
      const tmpDirectory = path.join(stageDirectory, 'tmp');
      await fsp.mkdir(stageDirectory, { mode: 0o700 });
      await Promise.all([inputsDirectory, pagesDirectory, thumbsDirectory, renderDirectory, tmpDirectory]
        .map(async (directory) => {
          await fsp.mkdir(directory, { mode: 0o700 });
          await fsp.chmod(directory, 0o700);
        }));

      emit('copying', 'Copying the selected files into a protected workspace.', 0, selection.length);
      const copied = [];
      let totalInputBytes = 0;
      for (let index = 0; index < selection.length; index += 1) {
        const selected = selection[index];
        const safeExtension = selected.expectedType === 'jpeg' ? '.jpg' : `.${selected.expectedType}`;
        const safeName = selected.expectedType === 'pdf'
          ? 'source.pdf'
          : `source-${String(index + 1).padStart(4, '0')}${safeExtension}`;
        const destination = path.join(inputsDirectory, safeName);
        const maxBytes = selected.expectedType === 'pdf' ? LIMITS.maxPdfBytes : LIMITS.maxImageBytes;
        const copiedFile = await copyTrustedInput(selected.sourcePath, destination, maxBytes);
        totalInputBytes += copiedFile.size;
        if (selected.expectedType !== 'pdf' && totalInputBytes > LIMITS.maxImageInputBytes) {
          fail('FILE_TOO_LARGE', 'The selected page images exceed the total import limit.');
        }
        const detectedType = detectMagic(await readHeader(destination));
        if (detectedType !== selected.expectedType) {
          fail('UNSUPPORTED_FORMAT', 'A selected file type does not match its contents.');
        }
        copied.push({
          relative: `inputs/${safeName}`,
          expectedType: selected.expectedType,
          sha256: copiedFile.sha256,
          size: copiedFile.size,
        });
        emit('copying', 'Copying the selected files into a protected workspace.', index + 1, selection.length);
      }
      await ensureFreeSpace(this.rootDirectory, totalInputBytes);

      const pdfImport = copied[0].expectedType === 'pdf';
      let pageInputs;
      let extractedText;
      if (pdfImport) {
        emit('validating', 'Inspecting the PDF page structure.');
        let info;
        try {
          const result = await runConstrainedTool(
            TOOLS.pdfinfo,
            ['/work/inputs/source.pdf'],
            {
              workspace: stageDirectory,
              timeout: 60 * 1000,
              maxBuffer: 2 * 1024 * 1024,
              allowSandboxFallback: this.allowSandboxFallbackForTests,
            },
          );
          info = parsePdfInfo(result.stdout);
        } catch (error) {
          if (error instanceof IssueReelError) throw error;
          fail('CORRUPT_DOCUMENT', 'The PDF could not be inspected safely.');
        }
        pageInputs = Array(info.pages).fill(null);
        emit('extracting', 'Extracting searchable text from the PDF.', 0, info.pages);
        extractedText = await extractPdfText(stageDirectory, info.pages, this.allowSandboxFallbackForTests);
      } else {
        pageInputs = copied.map((entry) => entry.relative);
        extractedText = Array(pageInputs.length).fill('');
      }

      const pages = [];
      let outputBytes = 0;
      for (let index = 0; index < pageInputs.length; index += 1) {
        const number = index + 1;
        await ensureFreeSpace(this.rootDirectory, LIMITS.maxPageOutputBytes);
        let inputRelative = pageInputs[index];
        let renderedRelative;
        if (pdfImport) {
          const stem = `page-${String(number).padStart(4, '0')}`;
          renderedRelative = `render/${stem}.jpg`;
          emit('rendering', 'Rendering the PDF into archival page frames.', index, pageInputs.length);
          try {
            await runConstrainedTool(TOOLS.pdftoppm, [
              '-f', String(number),
              '-l', String(number),
              '-singlefile',
              '-r', '144',
              '-scale-to', String(LIMITS.normalizedLongEdge),
              '-jpeg',
              '-jpegopt', 'quality=90,optimize=y,progressive=y',
              '/work/inputs/source.pdf',
              `/work/render/${stem}`,
            ], {
              workspace: stageDirectory,
              timeout: 3 * 60 * 1000,
              allowSandboxFallback: this.allowSandboxFallbackForTests,
            });
            if (detectMagic(await readHeader(path.join(stageDirectory, renderedRelative))) !== 'jpeg') {
              fail('CONVERSION_FAILED', 'A rendered PDF page was not a valid JPEG.');
            }
          } catch (error) {
            throw conversionFailure(error);
          }
          inputRelative = renderedRelative;
          emit('rendering', 'Rendering the PDF into archival page frames.', number, pageInputs.length);
        }
        emit('normalizing', 'Building consistent issue reel pages.', index, pageInputs.length);
        const pageRelative = `pages/page-${String(number).padStart(4, '0')}.jpg`;
        const thumbRelative = `thumbs/page-${String(number).padStart(4, '0')}.jpg`;
        try {
          await normalizePage(stageDirectory, inputRelative, pageRelative, this.allowSandboxFallbackForTests);
          await makeThumbnail(stageDirectory, pageRelative, thumbRelative, this.allowSandboxFallbackForTests);
          await Promise.all([
            fsp.chmod(path.join(stageDirectory, pageRelative), 0o600),
            fsp.chmod(path.join(stageDirectory, thumbRelative), 0o600),
          ]);
          if (renderedRelative) await fsp.rm(path.join(stageDirectory, renderedRelative), { force: true });
        } catch (error) {
          throw conversionFailure(error);
        }
        const inspected = await hashAndInspectJpeg(path.join(stageDirectory, pageRelative));
        const inspectedThumbnail = await hashAndInspectJpeg(path.join(stageDirectory, thumbRelative));
        if (inspectedThumbnail.width > 360 || inspectedThumbnail.height > 360) {
          fail('CONVERSION_FAILED', 'A reel thumbnail has unsafe dimensions.');
        }
        outputBytes += inspected.byteLength + inspectedThumbnail.byteLength;
        if (outputBytes > LIMITS.maxOutputBytes) {
          fail('FILE_TOO_LARGE', 'The normalized reel exceeds the output limit.');
        }
        const ocrText = extractedText[index] || '';
        pages.push({
          number,
          imageFile: pageRelative,
          thumbnailFile: thumbRelative,
          sha256: inspected.sha256,
          width: inspected.width,
          height: inspected.height,
          textSource: ocrText ? 'embedded' : 'none',
          ...(ocrText ? { ocrText } : {}),
        });
        emit('normalizing', 'Building consistent issue reel pages.', number, pageInputs.length);
      }

      emit('indexing', 'Building the local reel index.', pages.length, pages.length);
      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        id,
        metadata,
        importedAt: new Date().toISOString(),
        pageCount: pages.length,
        pages,
      };
      await fsp.rm(inputsDirectory, { recursive: true, force: true });
      await fsp.rm(renderDirectory, { recursive: true, force: true });
      await fsp.rm(tmpDirectory, { recursive: true, force: true });
      emit('finalizing', 'Sealing the local issue reel.', pages.length, pages.length);
      await writeAtomicJson(stageDirectory, 'manifest.json', manifest);
      await syncDirectory(stageDirectory);
      const finalDirectory = path.join(this.reelsDirectory, id);
      await fsp.rename(stageDirectory, finalDirectory);
      stageDirectory = undefined;
      await syncDirectory(this.reelsDirectory);
      emit('complete', 'The issue reel is ready.', pages.length, pages.length);
      return publicReel(validateManifest(manifest, id));
    } catch (error) {
      if (error && error.code === 'ENOSPC') throw new IssueReelError('STORAGE_FULL', 'There is not enough local storage for this reel.');
      if (error instanceof IssueReelError) throw error;
      throw new IssueReelError('IMPORT_FAILED', 'The issue reel could not be imported.');
    } finally {
      if (stageDirectory) {
        await fsp.rm(stageDirectory, { recursive: true, force: true }).catch(() => {});
      }
      this.importActive = false;
    }
  }

  async handleMediaRequest(request) {
    const method = request && typeof request === 'object' && request.method ? request.method : 'GET';
    const requestUrl = typeof request === 'string' ? request : request && request.url;
    if (method !== 'GET' || typeof requestUrl !== 'string') {
      return new Response(null, { status: 405, headers: { Allow: 'GET' } });
    }
    const asset = parseAssetUrl(requestUrl);
    if (!asset) return new Response(null, { status: 404 });
    let handle;
    try {
      const manifest = await this.readManifest(asset.id);
      const page = manifest.pages[asset.pageNumber - 1];
      if (!page || page.number !== asset.pageNumber) return new Response(null, { status: 404 });
      const fileName = asset.kind === 'page' ? page.imageFile : page.thumbnailFile;
      const safeRelative = assertSafeRelativeAsset(fileName, asset.kind, asset.pageNumber);
      const reelDirectory = path.join(this.reelsDirectory, asset.id);
      const assetPath = path.resolve(reelDirectory, safeRelative);
      if (!assetPath.startsWith(`${reelDirectory}${path.sep}`)) return new Response(null, { status: 404 });
      handle = await fsp.open(assetPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > LIMITS.maxPageOutputBytes) {
        return new Response(null, { status: 404 });
      }
      const data = await handle.readFile();
      return new Response(data, {
        status: 200,
        headers: {
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Content-Length': String(data.length),
          'Content-Security-Policy': "default-src 'none'",
          'Content-Type': 'image/jpeg',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}

let schemeRegistered = false;

function registerIssueReelScheme(protocolApi) {
  if (schemeRegistered) return;
  if (!protocolApi || typeof protocolApi.registerSchemesAsPrivileged !== 'function') {
    throw new TypeError('Electron protocol API is required.');
  }
  protocolApi.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
    },
  }]);
  schemeRegistered = true;
}

async function createIssueReelStore({ userDataPath, unsafeAllowSandboxFallbackForTests = false } = {}) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) || userDataPath.includes('\0')) {
    throw new TypeError('An absolute Electron userDataPath is required.');
  }
  if (typeof unsafeAllowSandboxFallbackForTests !== 'boolean') {
    throw new TypeError('The converter fallback test flag must be boolean.');
  }
  const store = new IssueReelStore(path.join(userDataPath, 'issue-reels'), unsafeAllowSandboxFallbackForTests);
  return store.initialize();
}

module.exports = {
  LIMITS,
  IssueReelError,
  createAssetUrl,
  createIssueReelStore,
  detectMagic,
  jpegDimensions,
  naturalPathCompare,
  parseAssetUrl,
  parsePdfInfo,
  registerIssueReelScheme,
  sanitizeExtractedText,
  validateMetadata,
  validateSelection,
};
