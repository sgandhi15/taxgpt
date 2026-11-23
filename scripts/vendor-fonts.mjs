// Copies the page's two fonts into public/vendor/fonts/, so the page loads them
// from our own site, pinned to the versions in package.json, with no requests
// to third-party hosts. Wrangler runs this before every `dev` and `deploy`.
import { cp, mkdir, rm } from 'node:fs/promises';

// Latin subset only (English and French). Both fonts are under the SIL Open Font License.
const fonts = {
  'plus-jakarta-sans': ['@fontsource-variable/plus-jakarta-sans', ['plus-jakarta-sans-latin-wght-normal.woff2', 'plus-jakarta-sans-latin-wght-italic.woff2']],
  // The optical-size cut, so headings get Bricolage's display shapes at large sizes.
  'bricolage-grotesque': ['@fontsource-variable/bricolage-grotesque', ['bricolage-grotesque-latin-opsz-normal.woff2']],
};

await rm('public/vendor', { recursive: true, force: true });
for (const [name, [pkg, files]] of Object.entries(fonts)) {
  const to = `public/vendor/fonts/${name}`;
  await mkdir(to, { recursive: true });
  for (const file of files) await cp(`node_modules/${pkg}/files/${file}`, `${to}/${file}`);
  await cp(`node_modules/${pkg}/LICENSE`, `${to}/LICENSE`);
}
console.log('Fonts copied to public/vendor/fonts');
