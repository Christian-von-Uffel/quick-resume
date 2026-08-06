import "./legal.css";

// Chrome for /privacy and /terms.
//
// The landing page's own nav and footer live inside content/landing-body.html
// as raw markup, so they can't be imported — this mirrors them in JSX instead.
// The one real difference: every landing link here is absolute ("/#how", not
// "#how"), because from these pages a bare fragment goes nowhere.
export default function LegalPage({ eyebrow, title, updated, children }) {
  return (
    <>
      <nav className="nav" id="nav">
        <div className="container nav-inner">
          <a className="logo" href="/">
            <span className="logo-mark">1</span>
            <span>Resume</span>
          </a>
          <div className="nav-links">
            <a href="/#problem">Why 1Resume</a>
            <a href="/#how">How it works</a>
            <a href="/#features">Features</a>
            <a href="/#pricing">Pricing</a>
            <a href="/#faq">FAQ</a>
          </div>
          <div className="nav-cta">
            <a className="btn btn-ghost" href="/login">
              Sign in
            </a>
            <a className="btn btn-primary" href="/signup">
              Start free trial
            </a>
          </div>
        </div>
      </nav>

      <main className="legal">
        <div className="container">
          <article className="legal-doc">
            <p className="legal-eyebrow">{eyebrow}</p>
            <h1>{title}</h1>
            <p className="legal-updated">Last updated {updated}</p>
            {children}
          </article>
        </div>
      </main>

      <footer className="footer">
        <div className="container footer-inner">
          <a className="logo" href="/">
            <span className="logo-mark">1</span>
            <span>resume</span>
          </a>
          <div className="footer-links">
            <a href="/#how">How it works</a>
            <a href="/#pricing">Pricing</a>
            <a href="/#faq">FAQ</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </div>
          <div className="footer-copy">
            © 2026 1Resume. The one-resume-for-everything platform.
          </div>
        </div>
      </footer>
    </>
  );
}
