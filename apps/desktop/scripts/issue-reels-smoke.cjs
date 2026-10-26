'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFile = promisify(childProcess.execFile);
const {
  createAssetUrl,
  createIssueReelStore,
  detectMagic,
  naturalPathCompare,
  parseAssetUrl,
  parsePdfInfo,
  registerIssueReelScheme,
  validateMetadata,
  validateSelection,
} = require('../electron/issue-reels.cjs');

const reelModuleSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'issue-reels.cjs'), 'utf8');
assert(reelModuleSource.includes('allowSandboxFallback = false'), 'production converter isolation must fail closed');
assert.equal(reelModuleSource.includes('allowSandboxFallback = true'), false, 'sandbox fallback must never be the runtime default');
assert(reelModuleSource.includes("if (!allowSandboxFallback)"), 'host conversion must require the explicit test fallback');
const unsafeTestFallback = process.env.MICROFICHE_REQUIRE_CONVERTER_SANDBOX !== '1';

function makePdf(pageTexts) {
  const pageIds = pageTexts.map((_, index) => 3 + index * 2);
  const fontId = 3 + pageTexts.length * 2;
  const objects = new Map();
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  pageTexts.forEach((text, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
    const stream = `BT /F1 24 Tf 72 700 Td (${escaped}) Tj ET\n`;
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  });
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const chunks = ['%PDF-1.4\n'];
  const offsets = [0];
  for (let id = 1; id <= fontId; id += 1) {
    offsets[id] = Buffer.byteLength(chunks.join(''));
    chunks.push(`${id} 0 obj\n${objects.get(id)}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(''));
  chunks.push(`xref\n0 ${fontId + 1}\n`);
  chunks.push('0000000000 65535 f \n');
  for (let id = 1; id <= fontId; id += 1) {
    chunks.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'ascii');
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error && error.code === code, `expected ${code}`);
}

async function main() {
  assert.deepEqual(validateMetadata({ publication: 'The Daily Test', issueDate: '1984-02-29' }), {
    publication: 'The Daily Test',
    issueDate: '1984-02-29',
  });
  for (const badDate of ['1984-02-30', '1984-13-01', '1984-00-01', '06/16/1984', '']) {
    assert.throws(() => validateMetadata({ publication: 'Test', issueDate: badDate }), /issueDate|date/i);
  }
  assert.throws(() => validateMetadata({ publication: 'Test\u202e', issueDate: '1984-01-01' }), /invalid/i);
  assert.throws(() => validateMetadata({ publication: 'Test', issueDate: '1984-01-01', surprise: true }), /unknown/i);
  assert.equal(detectMagic(Buffer.from('%PDF-1.7')), 'pdf');
  assert.equal(detectMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
  assert.equal(detectMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(detectMagic(Buffer.from('<svg>')), null);
  assert(naturalPathCompare('/tmp/page-2.png', '/tmp/page-10.png') < 0);
  assert.throws(() => validateSelection(['/tmp/a.pdf', '/tmp/b.pdf']), /one PDF/i);
  assert.throws(() => validateSelection(['/tmp/a.pdf', '/tmp/page.png']), /not both/i);
  assert.throws(() => validateSelection(['/tmp/page.svg']), /PDF, JPEG, and PNG/i);
  assert.deepEqual(parsePdfInfo('Pages:          2\nEncrypted:      no\n'), { pages: 2, encrypted: false });
  assert.throws(() => parsePdfInfo('Pages: 2\nEncrypted: yes (print:yes)\n'), /Encrypted/i);

  const id = '123e4567-e89b-42d3-a456-426614174000';
  const assetUrl = createAssetUrl(id, 'page', 1);
  assert.deepEqual(parseAssetUrl(assetUrl), { id, kind: 'page', pageNumber: 1 });
  for (const badUrl of [
    `microfiche-reel://asset/issue/${id}/page/0`,
    `microfiche-reel://asset/issue/${id}/page/501`,
    `microfiche-reel://asset/issue/${id}/original/1`,
    `microfiche-reel://asset/issue/${id}/page/1?path=../../etc/passwd`,
    `microfiche-reel://asset/issue/${id}/page/%2e%2e`,
    `file:///etc/passwd`,
  ]) assert.equal(parseAssetUrl(badUrl), null, badUrl);

  let schemeRegistration;
  registerIssueReelScheme({ registerSchemesAsPrivileged(value) { schemeRegistration = value; } });
  assert.equal(schemeRegistration[0].scheme, 'microfiche-reel');
  assert.equal(schemeRegistration[0].privileges.secure, true);

  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'microfiche-reel-smoke-'));
  try {
    const fixtureDirectory = path.join(temporaryRoot, 'fixtures');
    await fsp.mkdir(fixtureDirectory, { mode: 0o700 });
    const pageTwo = path.join(fixtureDirectory, 'page-2.png');
    const pageTen = path.join(fixtureDirectory, 'page-10.png');
    await execFile('/usr/bin/magick', ['-size', '320x480', 'xc:#f4ecd8', '-fill', '#111111', '-pointsize', '28', '-draw', 'text 36,80 PAGE-2', pageTwo]);
    await execFile('/usr/bin/magick', ['-size', '320x480', 'xc:#e7dfc7', '-fill', '#111111', '-pointsize', '28', '-draw', 'text 36,80 PAGE-10', pageTen]);

    const userDataPath = path.join(temporaryRoot, 'profile');
    const store = await createIssueReelStore({
      userDataPath,
      unsafeAllowSandboxFallbackForTests: unsafeTestFallback,
    });
    const imageProgress = [];
    const imageReel = await store.importFiles({
      metadata: {
        publication: 'Foxtail Test Chronicle',
        issueDate: '1984-03-10',
        edition: 'Morning',
        location: 'Philadelphia, Pennsylvania',
        sourceLabel: 'Local smoke fixture',
        sourceUrl: 'https://www.inquirer.com/archives/',
        rights: 'Testing only',
      },
      filePaths: [pageTen, pageTwo],
      onProgress: (event) => imageProgress.push(event),
    });
    assert.equal(imageReel.pageCount, 2);
    assert.equal(imageReel.pages.length, 2);
    assert.equal(imageReel.pages[0].textSource, 'none');
    assert.equal(imageReel.sourceUrl, 'https://www.inquirer.com/archives/');
    assert.equal(imageReel.pages[0].imageUrl.startsWith('microfiche-reel://asset/issue/'), true);
    assert.equal(JSON.stringify(imageReel).includes(temporaryRoot), false, 'renderer data must not expose local paths');
    for (const stage of ['validating', 'copying', 'normalizing', 'indexing', 'finalizing', 'complete']) {
      assert(imageProgress.some((event) => event.stage === stage), `missing ${stage} progress`);
    }

    const savedRoot = path.join(userDataPath, 'issue-reels', 'reels', imageReel.id);
    const pageStat = await fsp.stat(path.join(savedRoot, 'pages', 'page-0001.jpg'));
    const thumbStat = await fsp.stat(path.join(savedRoot, 'thumbs', 'page-0001.jpg'));
    const manifestStat = await fsp.stat(path.join(savedRoot, 'manifest.json'));
    assert.equal(pageStat.mode & 0o777, 0o600);
    assert.equal(thumbStat.mode & 0o777, 0o600);
    assert.equal(manifestStat.mode & 0o777, 0o600);

    const pageResponse = await store.handleMediaRequest({ method: 'GET', url: imageReel.pages[0].imageUrl });
    assert.equal(pageResponse.status, 200);
    assert.equal(pageResponse.headers.get('content-type'), 'image/jpeg');
    assert.equal(pageResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(detectMagic(Buffer.from(await pageResponse.arrayBuffer())), 'jpeg');
    assert.equal((await store.handleMediaRequest({ method: 'POST', url: imageReel.pages[0].imageUrl })).status, 405);
    assert.equal((await store.handleMediaRequest({ method: 'GET', url: `${imageReel.pages[0].imageUrl}?file=/etc/passwd` })).status, 404);

    const secondStore = await createIssueReelStore({
      userDataPath,
      unsafeAllowSandboxFallbackForTests: unsafeTestFallback,
    });
    const saved = await secondStore.list();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, imageReel.id);
    assert.equal((await secondStore.get(imageReel.id)).pages.length, 2);

    const symlink = path.join(fixtureDirectory, 'linked-page.png');
    await fsp.symlink(pageTwo, symlink);
    await expectCode(store.importFiles({
      metadata: { publication: 'Test', issueDate: '1984-03-10' },
      filePaths: [symlink],
    }), 'INVALID_SELECTION');

    const spoofed = path.join(fixtureDirectory, 'spoofed.png');
    await fsp.writeFile(spoofed, '%PDF-1.4\nnot really an image', { mode: 0o600 });
    await expectCode(store.importFiles({
      metadata: { publication: 'Test', issueDate: '1984-03-10' },
      filePaths: [spoofed],
    }), 'UNSUPPORTED_FORMAT');

    const pdfPath = path.join(fixtureDirectory, 'two-page-issue.pdf');
    await fsp.writeFile(pdfPath, makePdf(['PAGE ONE EMBEDDED TEXT', 'PAGE TWO EMBEDDED TEXT']), { mode: 0o600 });
    const pdfProgress = [];
    const pdfReel = await store.importFiles({
      metadata: { publication: 'Foxtail PDF Gazette', issueDate: '1937-05-07' },
      filePaths: [pdfPath],
      onProgress: (event) => pdfProgress.push(event),
    });
    assert.equal(pdfReel.pageCount, 2);
    assert.match(pdfReel.pages[0].ocrText || '', /PAGE ONE EMBEDDED TEXT/);
    assert.match(pdfReel.pages[1].ocrText || '', /PAGE TWO EMBEDDED TEXT/);
    assert(pdfProgress.some((event) => event.stage === 'rendering'));
    assert(pdfProgress.some((event) => event.stage === 'extracting'));

    const stagingEntries = await fsp.readdir(path.join(userDataPath, 'issue-reels', '.staging'));
    assert.deepEqual(stagingEntries, [], 'completed and failed imports must leave no staging residue');
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }

  console.log('Issue Reel security, conversion, persistence, and media smoke passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
