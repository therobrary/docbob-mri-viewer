import { APP_TITLE, MRI_MODALITY, PLANNED_MODALITIES } from '../config/modalities'

interface HomePageProps {
  onOpenMri: () => void
}

function HomePage({ onOpenMri }: HomePageProps) {
  return (
    <div className="app-shell">
      <header className="app-header home-header">
        <div>
          <pre className="ascii-banner" aria-hidden="true">
            {`>==[ DOCBOB://IMAGING ]==<
[ workers ][ gateway ][ modalities ]`}
          </pre>
          <p className="eyebrow">Cloudflare-native imaging analysis shell</p>
          <h1>{APP_TITLE}</h1>
          <p className="lede">
            This deployment is being structured as one Cloudflare Worker app with a shared landing experience and
            modality-specific workspaces. MRI is the first live interface; X-ray and skin-lesion analysis are being
            prepared on the same foundation for later rollout.
          </p>
        </div>
      </header>

      <main className="home-grid">
        <section className="card hero-panel">
          <div className="hero-copy">
            <span className="status-chip available">Available now</span>
            <h2>{MRI_MODALITY.label}</h2>
            <p>{MRI_MODALITY.summary}</p>
            <div className="hero-actions">
              <button type="button" onClick={onOpenMri}>
                Open MRI workspace
              </button>
            </div>
          </div>
        </section>

        <section className="card roadmap-panel">
          <h2>Infrastructure ready for next interfaces</h2>
          <p className="muted">
            The shared app shell, Worker API, and deployment path are being aligned so future interfaces can stay
            consistent without coupling every workflow to the MRI page.
          </p>

          <div className="roadmap-list">
            {PLANNED_MODALITIES.map((modality) => (
              <article key={modality.key} className="roadmap-item">
                <div>
                  <h3>{modality.shortLabel}</h3>
                  <p>{modality.summary}</p>
                </div>
                <span className="status-chip planned">Planned</span>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}

export default HomePage
