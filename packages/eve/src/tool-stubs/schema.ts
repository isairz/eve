import { Validator } from "#compiled/@cfworker/json-schema/index.js";
import type { JsonObject } from "#shared/json.js";

const schema = { $ref: "#" };
const schemaList = { type: "array", minItems: 1, items: schema };
const schemaMap = { type: "object", additionalProperties: schema };
const strings = { type: "array", uniqueItems: true, items: { type: "string" } };
const nonnegativeInteger = { type: "integer", minimum: 0 };
const jsonType = { enum: ["array", "boolean", "integer", "null", "number", "object", "string"] };

// The library validates data, but does not validate the schema itself:
// { minimun: 10 } is ignored and { minimum: "10" } is not rejected.
// Validate our supported, reference-free subset before using it to match inputs.
const constraintSchema = new Validator(
  {
    anyOf: [
      { type: "boolean" },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          type: {
            anyOf: [jsonType, { type: "array", minItems: 1, uniqueItems: true, items: jsonType }],
          },
          const: true,
          enum: { type: "array", minItems: 1, uniqueItems: true },
          title: { type: "string" },
          description: { type: "string" },
          default: true,
          minimum: { type: "number" },
          maximum: { type: "number" },
          exclusiveMinimum: { type: "number" },
          exclusiveMaximum: { type: "number" },
          multipleOf: { type: "number", exclusiveMinimum: 0 },
          minLength: nonnegativeInteger,
          maxLength: nonnegativeInteger,
          pattern: { type: "string", format: "regex", maxLength: 256 },
          minItems: nonnegativeInteger,
          maxItems: nonnegativeInteger,
          uniqueItems: { type: "boolean" },
          items: schema,
          prefixItems: schemaList,
          contains: schema,
          minContains: nonnegativeInteger,
          maxContains: nonnegativeInteger,
          minProperties: nonnegativeInteger,
          maxProperties: nonnegativeInteger,
          properties: schemaMap,
          patternProperties: { ...schemaMap, propertyNames: { format: "regex" } },
          propertyNames: schema,
          required: strings,
          additionalProperties: schema,
          dependentSchemas: schemaMap,
          dependentRequired: { type: "object", additionalProperties: strings },
          allOf: schemaList,
          anyOf: schemaList,
          oneOf: schemaList,
          not: schema,
          if: schema,
          // JSON Schema uses `then` as a keyword.
          // oxlint-disable-next-line unicorn/no-thenable
          then: schema,
          else: schema,
        },
      },
    ],
  },
  "2020-12",
);

export function validateStubConstraint(value: unknown, ruleId: string, property: string): void {
  const result = constraintSchema.validate(value);
  if (!result.valid) {
    const error = result.errors.at(-1)!;
    const detail = error.keyword === "false" ? "Unsupported JSON Schema keyword." : error.error;
    throw new Error(
      `Invalid matcher "${property}" in tool stub "${ruleId}" at ${error.instanceLocation}: ${detail}`,
    );
  }
}

export function createStubValidator(value: JsonObject | boolean): Validator {
  return new Validator(structuredClone(value), "2020-12");
}
