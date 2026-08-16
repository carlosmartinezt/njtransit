import { useEffect, useRef } from 'preact/hooks'
import type { Stop } from '../lib/types'

interface Props {
  stops: Stop[]
  currentId: string
  onPick: (id: string) => void
  onClose: () => void
}

export function StopPicker({ stops, currentId, onPick, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('[aria-current="true"], button')?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a terminal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div class="sheet__panel" ref={panel}>
        <h2 class="sheet__title">Choose a terminal</h2>

        {stops.map((s) => (
          <button
            key={s.id}
            type="button"
            class="stopbtn"
            aria-current={s.id === currentId}
            onClick={() => onPick(s.id)}
          >
            <span class="stopbtn__name">{s.name}</span>
            {s.city && <span class="stopbtn__city">{s.city}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
