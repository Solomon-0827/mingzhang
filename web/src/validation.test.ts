import { expect, it } from "vitest";
import names from "../../tests/fixtures/category-name-validation.json";
import { categoryNameError } from "./validation";

it.each(names)("category name: $case", ({ action, level, path, name, repeat, status }) => {
  const label = repeat ? "🐱".repeat(repeat) : name!;
  const addedPath = action === "add" ? (level === "parent" ? label : path + "/" + label) : undefined;
  expect(categoryNameError(label, addedPath) === undefined).toBe(status === 200);
});
