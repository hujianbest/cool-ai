import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const productDirectories = ["app", "components"].map((directory) =>
  join(process.cwd(), directory)
);

function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(path);
    return [".tsx", ".jsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

describe("input placeholders", () => {
  it("uses placeholders only for supported text inputs and labels choice inputs", () => {
    const violations: string[] = [];
    const placeholderTypes = new Set(["email", "password", "search", "tel", "text", "url"]);

    for (const path of productDirectories.flatMap(componentFiles)) {
      const source = readFileSync(path, "utf8");
      const sourceFile = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const labels = new Set<string>();

      function collectLabels(node: ts.Node) {
        if (
          ts.isJsxElement(node)
          && node.openingElement.tagName.getText(sourceFile) === "label"
        ) {
          const text = node.children
            .filter(ts.isJsxText)
            .map((child) => child.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (text) labels.add(text);
        }
        ts.forEachChild(node, collectLabels);
      }

      collectLabels(sourceFile);

      function inspect(node: ts.Node) {
        if (
          ts.isJsxSelfClosingElement(node)
          && node.tagName.getText(sourceFile) === "input"
        ) {
          const typeAttribute = node.attributes.properties.find(
            (attribute): attribute is ts.JsxAttribute =>
              ts.isJsxAttribute(attribute)
              && attribute.name.getText(sourceFile) === "type",
          );
          const staticType = typeAttribute?.initializer && ts.isStringLiteral(typeAttribute.initializer)
            ? typeAttribute.initializer.text
            : null;
          const supportsPlaceholder = !typeAttribute
            || staticType === null
            || placeholderTypes.has(staticType);
          const placeholder = node.attributes.properties.find(
            (attribute): attribute is ts.JsxAttribute =>
              ts.isJsxAttribute(attribute)
              && attribute.name.getText(sourceFile) === "placeholder",
          );
          const value = placeholder?.initializer && ts.isStringLiteral(placeholder.initializer)
            ? placeholder.initializer.text.trim()
            : "";

          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          if (supportsPlaceholder && !value) {
            violations.push(`${relative(process.cwd(), path)}:${line} missing placeholder`);
          } else if (supportsPlaceholder && labels.has(value)) {
            violations.push(`${relative(process.cwd(), path)}:${line} repeats label "${value}"`);
          } else if (!supportsPlaceholder && placeholder) {
            violations.push(
              `${relative(process.cwd(), path)}:${line} ${staticType} must not have placeholder`,
            );
          }

          if (staticType === "checkbox" || staticType === "radio") {
            let ancestor: ts.Node | undefined = node.parent;
            let nestedInLabel = false;
            while (ancestor) {
              if (
                ts.isJsxElement(ancestor)
                && ancestor.openingElement.tagName.getText(sourceFile) === "label"
              ) {
                nestedInLabel = true;
                break;
              }
              ancestor = ancestor.parent;
            }
            if (!nestedInLabel) {
              violations.push(
                `${relative(process.cwd(), path)}:${line} ${staticType} must remain label-associated`,
              );
            }
          }
        }
        ts.forEachChild(node, inspect);
      }

      inspect(sourceFile);
    }

    expect(violations, `invalid input placeholders:\n${violations.join("\n")}`).toEqual([]);
  });
});
