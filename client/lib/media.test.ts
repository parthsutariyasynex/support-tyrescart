import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkFile, documentLabel, filePreview, fileType, formatSize, imageProblem, isMediaPlaceholder, pastedName } from './media';

const MB = 1024 * 1024;
describe('files before sending', () => {
  test('images: JPEG/PNG up to 5 MB', () => {
    assert.equal(imageProblem({ name: 'a.png', type: 'image/png', size: 1000 }), null);
    assert.equal(imageProblem({ name: 'a.jpg', type: 'image/jpeg', size: 5 * MB }), null);
    assert.match(imageProblem({ name: 'a.gif', type: 'image/gif', size: 1000 })!, /Only JPEG and PNG/);
    assert.match(imageProblem({ name: 'a.png', type: 'image/png', size: 6 * MB })!, /6\.0 MB.*up to 5 MB/);
  });
  test('documents: PDF/Office/text up to 100 MB, recognised by extension too', () => {
    assert.deepEqual(checkFile({ name: 'quote.pdf', type: 'application/pdf', size: 1000 }), { kind: 'document', type: 'application/pdf' });
    assert.deepEqual(checkFile({ name: 'Invoice.DOCX', type: '', size: 1000 }), { kind: 'document', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    assert.deepEqual(checkFile({ name: 'photo.JPG', type: '', size: 1000 }), { kind: 'image', type: 'image/jpeg' });
    assert.match((checkFile({ name: 'a.pdf', type: 'application/pdf', size: 101 * MB }) as any).problem, /up to 100 MB/);
    assert.match((checkFile({ name: 'setup.exe', type: 'application/x-msdownload', size: 10 }) as any).problem, /can't be sent/);
    assert.match((checkFile({ name: 'a.txt', type: 'text/plain', size: 0 }) as any).problem, /empty/);
    assert.equal(fileType({ name: 'sheet.xlsx', type: 'application/octet-stream' }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
  test('labels and sizes', () => {
    assert.equal(documentLabel('application/pdf', 'a.pdf'), 'PDF');
    assert.equal(documentLabel(null, 'notes.txt'), 'TXT');
    assert.deepEqual([formatSize(500), formatSize(2048), formatSize(3.5 * MB)], ['500 B', '2 KB', '3.5 MB']);
  });
  test('placeholders and chat list previews', () => {
    assert.equal(isMediaPlaceholder('[image]'), true);
    assert.equal(isMediaPlaceholder('[text]'), false);
    assert.equal(isMediaPlaceholder('my tyre'), false);
    assert.equal(filePreview({ type: 'image', body: '[image]' }), '📷 Photo');
    assert.equal(filePreview({ type: 'image', body: 'my tyre' }), '📷 my tyre');
    assert.equal(filePreview({ type: 'voice', body: '[audio]' }), '🎤 Voice message');
    assert.equal(filePreview({ type: 'document', body: '[document]', mediaName: 'invoice.pdf' }), '📄 invoice.pdf');
    assert.equal(filePreview({ type: 'text', body: 'hi' }), null);
  });
});

test('pasted screenshots get a readable name; copied files keep theirs', () => {
  const at = new Date(2026, 9, 21, 14, 30, 5);
  assert.equal(pastedName(new File(['x'], 'image.png', { type: 'image/png' }), at).name, 'Screenshot 2026-10-21 at 14.30.05.png');
  assert.equal(pastedName(new File(['x'], '', { type: 'image/jpeg' }), at).name, 'Screenshot 2026-10-21 at 14.30.05.jpg');
  const kept = pastedName(new File(['x'], 'invoice.pdf', { type: 'application/pdf' }), at);
  assert.equal(kept.name, 'invoice.pdf');
  assert.equal(pastedName(new File(['x'], 'image.png', { type: 'image/png' }), at).type, 'image/png');
});
