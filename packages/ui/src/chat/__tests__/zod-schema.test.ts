import { describe, it, expect } from "vitest"
import { z } from "zod"

type JsonSchema = Record<string, unknown> & {
  type?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  enum?: unknown[]
  anyOf?: JsonSchema[]
}

function toJsonSchema(schema: z.ZodType): JsonSchema {
  return (schema as unknown as { toJSONSchema: () => JsonSchema }).toJSONSchema()
}

describe("zodToJsonSchema compatibility", () => {
  it("converts simple object schema", () => {
    const schema = z.object({ path: z.string().describe("File path") })
    const json = toJsonSchema(schema)
    expect(json.type).toBe("object")
    expect(json.properties!.path.type).toBe("string")
  })

  it("includes description from describe()", () => {
    const schema = z.object({ query: z.string().describe("Search query") })
    const json = toJsonSchema(schema)
    expect(json.properties!.query.description).toBe("Search query")
  })

  it("converts enum", () => {
    const schema = z.enum(["small", "medium", "large"])
    const json = toJsonSchema(schema)
    expect(json.type).toBe("string")
    expect(json.enum).toContain("small")
  })

  it("converts array", () => {
    const schema = z.array(z.string())
    const json = toJsonSchema(schema)
    expect(json.type).toBe("array")
    expect(json.items!.type).toBe("string")
  })

  it("converts nested object", () => {
    const schema = z.object({
      name: z.string(),
      config: z.object({ enabled: z.boolean(), count: z.number().optional() }),
    })
    const json = toJsonSchema(schema)
    expect(json.properties!.config.properties!.enabled.type).toBe("boolean")
  })

  it("converts union", () => {
    const schema = z.union([z.string(), z.number()])
    const json = toJsonSchema(schema)
    expect(json.anyOf).toBeDefined()
    expect(json.anyOf!.length).toBe(2)
  })

  it("produces valid OpenAI function calling format", () => {
    const schema = z.object({
      command: z.string().describe("Shell command"),
      timeout: z.number().optional().default(30),
    })
    const json = toJsonSchema(schema)
    const openaiTool = { type: "function", function: { name: "bash", description: "Execute command", parameters: json } }
    expect(openaiTool.function.parameters.properties!.command).toBeDefined()
    expect(openaiTool.function.parameters.properties!.timeout.type).toBe("number")
  })
})
