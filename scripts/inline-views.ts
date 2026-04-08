import { readFileSync, writeFileSync } from "node:fs";

const views = [
  { htmlSrc: "src/mainview/index.html", tsSrc: "src/mainview/index.ts", outHtml: "src/mainview/index.inline.html", outJs: "src/mainview/index.js" },
  { htmlSrc: "src/mainview/setup.html", tsSrc: "src/mainview/setup.ts", outHtml: "src/mainview/setup.inline.html", outJs: "src/mainview/setup.js" },
];

for (const view of views) {
  const proc = Bun.spawnSync(["bun", "build", view.tsSrc, "--target", "browser", "--outfile", view.outJs]);
  if (proc.exitCode !== 0) {
    console.error(`Failed to build ${view.tsSrc}`);
    console.error(proc.stderr.toString());
    process.exit(1);
  }
  const jsContent = readFileSync(view.outJs, "utf-8");

  // Generate inline HTML (for electrobun legacy / packaging)
  let inlineHtml = readFileSync(view.htmlSrc, "utf-8");
  const jsFileName = view.outJs.replace("src/mainview/", "");
  inlineHtml = inlineHtml.replace(
    new RegExp(`<script\\s+src="${jsFileName.replace(".", "\\.")}"\\s*><\\/script>`),
    `<script>\n${jsContent}\n</script>`
  );

  writeFileSync(view.outHtml, inlineHtml);
  console.log(`Built ${view.outJs} and generated ${view.outHtml}`);
}
