// Google-only auth UI + shared avatar helpers.
//
// Login is a full-page navigation to the backend's OAuth entry point — NOT a
// fetch — because the browser has to follow Google's redirects. After Google
// bounces back to /api/auth/google/callback the backend sets the session
// cookie and redirects to the app, where App re-checks /api/auth/me.

function initialsFromName(nameOrEmail) {
  if (!nameOrEmail) return '?';
  const base = String(nameOrEmail).split('@')[0].trim();
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

// One avatar everywhere: the Google picture if we have one, else initials.
// `referrerPolicy="no-referrer"` keeps Google's CDN from 403-ing the image.
function UserAvatar({ user, className, style, title }) {
  const label = user?.displayName || user?.email || '';
  if (user?.avatarUrl) {
    return (
      <div className={className} style={style} title={title || label}>
        <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer"
             style={{ width: '100%', height: '100%', borderRadius: '50%',
                      objectFit: 'cover', display: 'block' }} />
      </div>
    );
  }
  return <div className={className} style={style} title={title || label}>{initialsFromName(label)}</div>;
}

function GoogleMark() {
  // Google's "G" — official 4-color glyph.
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
    </svg>
  );
}

// What we tell people on the way in. Each ties to a real feature of the app.
const LANDING_FEATURES = [
  { title: 'Organize everything', desc: 'Group chats into folders so every subject has a home.' },
  { title: 'Built for studying', desc: 'Math, tables, and code render cleanly — not as raw text.' },
  { title: 'Pick your model', desc: 'Switch between fast and deep AI models per question.' },
];

function AuthView() {
  // Surface a failed/cancelled Google sign-in (backend redirects to ?login=failed).
  const failed = new URLSearchParams(window.location.search).get('login') === 'failed';
  const signIn = () => { window.location.href = '/api/auth/google/login'; };

  return (
    <div className="landing">
      {/* Left: brand + value proposition */}
      <div className="landing-brand">
        <div className="landing-brandbar">
          <div className="mark"><div className="a"/><div className="b"/></div>
          <div className="word">StudyAI</div>
        </div>

        <div className="landing-pitch">
          <h1>Study smarter,<br/>not harder.</h1>
          <div className="sub">
            Your AI study partner that keeps notes, chats, and explanations
            organized — so you can focus on actually learning.
          </div>
          <div className="landing-features">
            {LANDING_FEATURES.map(f => (
              <div className="landing-feature" key={f.title}>
                <span className="tick"><I.check size={13} strokeWidth={2.5} /></span>
                <span>
                  <span className="ft-title">{f.title}.</span>{' '}
                  <span className="ft-desc">{f.desc}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="landing-foot">© {new Date().getFullYear()} StudyAI · Your data stays private to you.</div>
      </div>

      {/* Right: login */}
      <div className="landing-auth">
        <div className="landing-card">
          <h2>Log in to your account</h2>
          <div className="lead">Sign in to access your folders and chats.</div>

          {failed && (
            <div className="landing-error">Sign-in didn’t complete. Please try again.</div>
          )}

          <button onClick={signIn} className="landing-google">
            <span className="g-chip"><GoogleMark /></span>
            Continue with Google
          </button>

          <div className="landing-divider">Secure sign-in</div>

          <div className="landing-terms">
            We only use your Google account to identify you. By continuing you agree
            to keep it classy — no terms-of-service novel required.
          </div>
        </div>
      </div>
    </div>
  );
}

window.initialsFromName = initialsFromName;
window.UserAvatar = UserAvatar;
window.AuthView = AuthView;
