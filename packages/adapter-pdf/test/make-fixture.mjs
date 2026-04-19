// Generates test/fixtures/sample.pdf
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'fixtures');
mkdirSync(outDir, { recursive: true });

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);

const p1 = doc.addPage([400, 300]);
p1.drawText('Hello World', { x: 50, y: 250, size: 18, font });
p1.drawText('This is page one of a test PDF.', { x: 50, y: 220, size: 12, font });
p1.drawText('Line two on page one.', { x: 50, y: 200, size: 12, font });

const p2 = doc.addPage([400, 300]);
p2.drawText('Page Two Title', { x: 50, y: 250, size: 18, font });
p2.drawText('Some content on the second page.', { x: 50, y: 220, size: 12, font });

doc.setTitle('Sample Test PDF');

const bytes = await doc.save();
const out = path.join(outDir, 'sample.pdf');
writeFileSync(out, bytes);
console.log('wrote', out, '(', bytes.length, 'bytes )');
