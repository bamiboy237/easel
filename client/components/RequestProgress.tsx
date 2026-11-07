import { useRef } from 'react'
import { useValue } from 'tldraw'
import type { TldrawAgent } from '../agent/TldrawAgent'
import { EXPECTED_MS, ProgressBar, useLingering } from './ProgressBar'

/**
 * The progress of the agent's current request, typed, spoken, or delegated by
 * the voice: an estimate from when it started, since a model pass reports no
 * progress of its own. It fills when the request ends, then goes.
 */
export function RequestProgress({ agent, label = 'Working on the request', className }: { agent: TldrawAgent; label?: string; className?: string }) {
	const startedAt = useValue('request started at', () => agent.requests.getStartedAt(), [agent])
	const last = useRef<number | null>(null)
	if (startedAt !== null) last.current = startedAt
	const visible = useLingering(startedAt !== null)
	if (!visible || last.current === null) return null
	return (
		<ProgressBar
			className={className}
			label={label}
			runKey={last.current}
			estimate={{ startedAt: last.current, expectedMs: EXPECTED_MS.request }}
			done={startedAt === null}
		/>
	)
}
