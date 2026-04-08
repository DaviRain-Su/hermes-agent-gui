import { readFileSync, writeFileSync } from "node:fs";

const views = [
  { htmlSrc: "src/mainview/index.html", tsSrc: "src/mainview/index.ts", outHtml: "src/mainview/index.inline.html" },
  { htmlSrc: "src/mainview/setup.html", tsSrc: "src/mainview/setup.ts", outHtml: "src/mainview/setup.inline.html" },
];

for (const view of views) {
  const proc = Bun.spawnSync(["bun", "build", view.tsSrc, "--target", "browser"]);
  if (proc.exitCode !== 0) {
    console.error(`Failed to build ${view.tsSrc}`);
    console.error(proc.stderr.toString());
    process.exit(1);
  }
  const jsContent = proc.stdout.toString();

  let html = readFileSync(view.htmlSrc, "utf-8");
  html = html.replace(
    /<script\s+type="module"\s+src="[^"]+"><\/script>/,
    `<script>\n${jsContent}\n</script>`
  );

  writeFileSync(view.outHtml, html);
  console.log(`Generated ${view.outHtml}`);
}
