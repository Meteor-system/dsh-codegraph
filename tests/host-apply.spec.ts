import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../src/index.ts'
import type { HostContext, HostSkillRegistration, HostToolDefinition } from '../src/contract.ts'

function makeHost(opts?: { skills?: boolean }): {
  ctx: HostContext
  registrations: HostToolDefinition[]
  skills: HostSkillRegistration[]
} {
  const registrations: HostToolDefinition[] = []
  const skills: HostSkillRegistration[] = []
  const ctx: HostContext = {
    tools: {
      register(definition) {
        registrations.push(definition)
        return () => {
          const at = registrations.indexOf(definition)
          if (at !== -1) registrations.splice(at, 1)
        }
      },
    },
  }
  if (opts?.skills !== false) {
    ctx.skills = {
      register(skill) {
        skills.push(skill)
        return () => {
          const at = skills.indexOf(skill)
          if (at !== -1) skills.splice(at, 1)
        }
      },
    }
  }
  return { ctx, registrations, skills }
}

describe('host apply (cordis plugin shape)', () => {
  it('exports apply, inject, and the package name the loader resolves', () => {
    expect(name).toBe('dsh-codegraph')
    expect(inject).toEqual(['tools'])
    expect(typeof apply).toBe('function')
  })

  it('registers nothing when disabled (the default)', () => {
    const { ctx, registrations } = makeHost()
    apply(ctx, { projectRoot: '/proj' })
    expect(registrations).toHaveLength(0)
  })

  it('registers codegraph_explore on ctx.tools when enabled', () => {
    const { ctx, registrations } = makeHost()
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    expect(registrations).toHaveLength(1)
    expect(registrations[0].name).toBe('codegraph_explore')
    expect(registrations[0].timeoutMs).toBe(300_000)
    expect(typeof registrations[0].execute).toBe('function')
    expect(typeof registrations[0].output.render).toBe('function')
  })

  it('indexes the session cwd rather than the apply-time process cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codegraph-cwd-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'one.ts'), 'export function sessionOnly(): number { return 1 }\n')
    const { ctx, registrations } = makeHost()
    apply(ctx, { enabled: true, projectRoot: '/this/is/not/the/project' })
    const result = await registrations[0].execute(
      { mode: 'callers', target: 'sessionOnly' },
      { agent: { session: { header: { cwd: root } } } },
    ) as { paths: unknown[] }
    expect(result.paths.length).toBeGreaterThan(0)
  })

  it('host execute returns lossless JSON (no undefined fields)', async () => {
    const { ctx, registrations } = makeHost()
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    const result = await registrations[0].execute({ mode: 'callers', target: 'apply' }) as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    expect(Object.prototype.hasOwnProperty.call(result.metadata as object, 'impact')).toBe(false)
  })

  it('an already-aborted host signal returns indexing instead of hanging', async () => {
    const { ctx, registrations } = makeHost()
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    const ac = new AbortController()
    ac.abort()
    const result = await registrations[0].execute({ mode: 'callers', target: 'apply' }, { signal: ac.signal }) as {
      diagnostics: Array<{ code: string }>
      metadata: { index: { status: string } }
    }
    expect(result.diagnostics.some((d) => d.code === 'indexing')).toBe(true)
    expect(result.metadata.index.status).toBe('indexing')
  })

  it('re-activation does not duplicate the host registration', () => {
    const { ctx, registrations } = makeHost()
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    expect(registrations).toHaveLength(1)
  })

  it('registers a user-invocable skill named codegraph when enabled', () => {
    const { ctx, skills } = makeHost()
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('codegraph')
    expect(skills[0].invocation?.userInvocable).toBe(true)
    expect(skills[0].description.length).toBeGreaterThan(0)
    expect(skills[0].content.length).toBeGreaterThan(0)
    expect(skills[0].source).toBe('runtime')
  })

  it('registers no skill when disabled or when config is absent', () => {
    const disabled = makeHost()
    apply(disabled.ctx, { projectRoot: '/proj' })
    expect(disabled.skills).toHaveLength(0)

    const absent = makeHost()
    apply(absent.ctx, { projectRoot: '/proj-no-config' })
    expect(absent.skills).toHaveLength(0)
  })

  it('missing ctx.skills still registers the tool and does not throw', () => {
    const { ctx, registrations, skills } = makeHost({ skills: false })
    expect(() => apply(ctx, { enabled: true, projectRoot: '/proj' })).not.toThrow()
    expect(registrations).toHaveLength(1)
    expect(registrations[0].name).toBe('codegraph_explore')
    expect(skills).toHaveLength(0)
  })

  it('registers the skill via ctx.get("skills") when that is how the host exposes it', () => {
    const skills: HostSkillRegistration[] = []
    const { ctx, registrations } = makeHost({ skills: false })
    ctx.get = (name) => {
      if (name !== 'skills') return undefined
      return {
        register(skill: HostSkillRegistration) {
          skills.push(skill)
          return () => {}
        },
      }
    }
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    expect(registrations).toHaveLength(1)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('codegraph')
    expect(skills[0].invocation?.userInvocable).toBe(true)
  })

  it('re-apply does not duplicate the skill', () => {
    const { ctx, skills } = makeHost()
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    expect(skills).toHaveLength(1)
  })
})

describe('codegraph skill body', () => {
  function body(): string {
    const { ctx, skills } = makeHost()
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    return skills[0].content
  }

  it('requires warmup through codegraph_explore only (no fourth mode, no index-store writes)', () => {
    const text = body()
    expect(text).toContain('codegraph_explore')
    expect(text).toMatch(/\bmode\b/)
    expect(text).toMatch(/\btarget\b/)
    expect(text).not.toMatch(/mode:\s*['"]warmup['"]/)
    expect(text).not.toMatch(/write.{0,80}\.dsh\/codegraph/i)
  })

  it('stops on indexing before the diff impact pass and tells the user to retry', () => {
    const text = body()
    expect(text).toContain('indexing')
    expect(text.toLowerCase()).toContain('retry')
    expect(text.toLowerCase()).toContain('diff impact')
  })

  it('skips the diff impact pass when the working tree is clean', () => {
    const text = body()
    expect(text.toLowerCase()).toMatch(/clean/)
    expect(text.toLowerCase()).toMatch(/skip/)
  })

  it('caps dirty-tree symbols at ten, truncates overflow, and falls back to path scope', () => {
    const text = body()
    expect(text).toMatch(/\b10\b|\bten\b/i)
    expect(text.toLowerCase()).toMatch(/truncat/)
    expect(text).toContain('scope')
  })
})
