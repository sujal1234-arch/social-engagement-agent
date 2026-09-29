import { useCallback, useEffect, useState } from 'react';

const btn = {
  primary: 'btn btn-primary',
  secondary: 'btn btn-secondary',
  small: 'btn btn-small',
};

function Pill({ tone = 'neutral', children }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [rec, setRec] = useState(null);
  const [loadingRec, setLoadingRec] = useState(false);
  const [abId, setAbId] = useState(null);
  const [abResults, setAbResults] = useState(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [memory, setMemory] = useState(null);
  const [comments, setComments] = useState([]);
  const [modalComment, setModalComment] = useState(null);
  const [modalReply, setModalReply] = useState('');
  const [modalTag, setModalTag] = useState('');
  const [modalLoading, setModalLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [user, setUser] = useState(null); // { id, email, name }
  const [authModal, setAuthModal] = useState(null); // 'login' | 'register'
  const [authForm, setAuthForm] = useState({ email: '', password: '', name: '' });
  const [authBusy, setAuthBusy] = useState(false);
  const [connections, setConnections] = useState([]);
  const [platforms, setPlatforms] = useState([]);
  const [form, setForm] = useState({
    hook: '',
    hook_b: '',
    caption: '',
    hashtags: '',
    best_time: '',
    schedule_time: '',
  });
  const [channel, setChannel] = useState('linkedin');
  const [approved, setApproved] = useState(false);
  const [scheduledA, setScheduledA] = useState(false);
  const [scheduledB, setScheduledB] = useState(false);

  const BASE_URL = '';

  const showToast = useCallback((msg) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 3500);
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch('/api/health');
      setHealth(await r.json());
    } catch {
      setHealth({ ok: false });
    }
  }, []);

  const loadMemory = useCallback(async () => {
    try {
      const r = await fetch('/api/memory', { headers: authHeaders() });
      setMemory(await r.json());
    } catch {
      /* ignore */
    }
  }, []);

  const loadComments = useCallback(async () => {
    try {
      const r = await fetch('/api/comments');
      const data = await r.json();
      setComments(data.comments || []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadMemory();
    loadComments();
    loadPlatforms();
    restoreSession();
  }, [loadHealth, loadMemory, loadComments]);

  const authHeaders = useCallback(() => {
    const t = localStorage.getItem('sea_token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  }, []);

  async function restoreSession() {
    const t = localStorage.getItem('sea_token');
    if (!t) return;
    try {
      const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${t}` } });
      if (r.ok) {
        const data = await r.json();
        setUser(data.user);
        setConnections(data.connections || []);
      } else {
        localStorage.removeItem('sea_token');
      }
    } catch { /* offline */ }
  }

  async function loadPlatforms() {
    try {
      const r = await fetch('/api/platforms');
      const data = await r.json();
      setPlatforms(data.platforms || []);
    } catch { /* ignore */ }
  }

  async function submitAuth(e) {
    e.preventDefault();
    setAuthBusy(true);
    try {
      const r = await fetch(authModal === 'login' ? '/api/login' : '/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authModal === 'login'
          ? { email: authForm.email, password: authForm.password }
          : { email: authForm.email, password: authForm.password, name: authForm.name }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed');
      localStorage.setItem('sea_token', data.token);
      setUser(data.user);
      const me = await fetch('/api/me', { headers: { Authorization: `Bearer ${data.token}` } }).then((x) => x.json());
      setConnections(me.connections || []);
      setAuthModal(null);
      showToast(`Signed in as ${data.user.name || data.user.email} ✓`);
      loadMemory();
    } catch (err) {
      showToast(String(err.message || err));
    } finally {
      setAuthBusy(false);
    }
  }

  function logout() {
    localStorage.removeItem('sea_token');
    setUser(null);
    setConnections([]);
    showToast('Signed out');
  }

  async function connectPlatform(platform) {
    if (!user) { setAuthModal('login'); return; }
    try {
      const r = await fetch(`/api/connect/${platform}/start`, { headers: authHeaders() });
      const data = await r.json();
      if (data.demo) {
        const c = await fetch(BASE_URL + data.confirm_url).then((x) => x.json());
        if (!c.ok) throw new Error(c.error || 'Connect failed');
        showToast(c.message);
      } else if (data.ok === undefined) {
        window.location.href = r.url; // real OAuth redirect
        return;
      }
      const me = await fetch('/api/me', { headers: authHeaders() }).then((x) => x.json());
      setConnections(me.connections || []);
      loadMemory();
    } catch (err) {
      showToast(String(err.message || err));
    }
  }

  async function disconnectPlatform(platform) {
    try {
      await fetch('/api/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ platform }),
      });
      setConnections((cs) => cs.filter((c) => c.platform !== platform));
      showToast(`${platform} disconnected`);
    } catch (err) {
      showToast(String(err.message || err));
    }
  }

  const connectedPlatforms = new Set(connections.map((c) => c.platform));

  async function recommend() {
    setLoadingRec(true);
    try {
      const r = await fetch(`/api/recommend?channel=${encodeURIComponent(channel)}`, { headers: authHeaders() });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setRec(data);
      setForm({
        hook: data.hook || '',
        hook_b: data.hook_b || '',
        caption: data.caption || '',
        hashtags: (data.hashtags || []).join(' '),
        best_time: data.best_time || '',
        schedule_time: '',
      });
      setApproved(false);
      setScheduledA(false);
      setScheduledB(false);
      setAbResults(null);
      setAbId(null);
      loadMemory();
    } catch (err) {
      showToast(`Recommend failed: ${err.message}`);
    } finally {
      setLoadingRec(false);
    }
  }

  async function createAb() {
    if (!form.hook || !form.hook_b) {
      showToast('Both hooks are needed for the A/B test');
      return;
    }
    try {
      const r = await fetch('/api/create-ab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          channel,
          hook: form.hook,
          hook_b: form.hook_b,
          caption: form.caption,
          hashtags: form.hashtags.split(/\s+/).filter(Boolean),
          best_time: form.best_time,
        }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error);
      setAbId(data.ab_id);
      setScheduledA(false);
      setScheduledB(false);
      setAbResults(null);
      showToast(`A/B test ${data.ab_id} created — approve, then schedule both variants`);
    } catch (err) {
      showToast(`Create A/B failed: ${err.message}`);
    }
  }

  async function schedule(variant) {
    if (!approved) {
      showToast('Human approval required before scheduling');
      return;
    }
    if (!abId) {
      showToast('Create the A/B test first');
      return;
    }
    try {
      const r = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ab_id: abId,
          variant,
          memory_informed: variant === 'A',
          time: form.schedule_time || undefined,
        }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error);
      if (variant === 'A') setScheduledA(true);
      else setScheduledB(true);
      if (data.both_scheduled) showToast('Both variants scheduled — fetch results to run the 48h simulation');
      else showToast(`Variant ${variant} scheduled`);
    } catch (err) {
      showToast(`Schedule failed: ${err.message}`);
    }
  }

  async function fetchResults() {
    if (!abId) {
      showToast('Create and schedule the A/B test first');
      return;
    }
    setLoadingResults(true);
    try {
      const r = await fetch(`/api/ab-results/${abId}`);
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setAbResults(data);
      loadMemory();
      showToast(data.memory_writeback ? 'Winner written back to Hindsight memory ✓' : 'Results loaded');
    } catch (err) {
      showToast(`Fetch results failed: ${err.message}`);
    } finally {
      setLoadingResults(false);
    }
  }

  async function openCommentModal(c) {
    setModalComment(c);
    setModalReply(c.suggested_reply || '');
    setModalTag(c.tag || '');
    setModalLoading(true);
    try {
      const r = await fetch('/api/reply-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ comment: c.text }),
      });
      const data = await r.json();
      if (!data.error) {
        setModalReply(data.reply || '');
        setModalTag(data.tag || '');
      }
    } catch {
      /* keep template reply as fallback */
    } finally {
      setModalLoading(false);
    }
  }

  const memoryInformed = Boolean(rec?.examples?.length);

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Social Media Engagement Agent</h1>
          <p className="subtitle">
            Recommend → A/B test → winner written back to memory. Powered by{' '}
            <strong>Hindsight</strong> {health?.memory_bank ? `(${health.memory_bank})` : ''}
          </p>
        </div>
        <div className="status">
          <Pill tone={health?.memory_mode === 'hindsight' ? 'good' : health?.memory_mode === 'fallback' ? 'warn' : 'neutral'}>
            memory: {health?.memory_mode || '…'}
          </Pill>
          <Pill tone="neutral">llm: {health?.llm || '…'}</Pill>
          {user ? (
            <>
              <Pill tone="good">Signed in as {user.name || user.email}</Pill>
              <button className={btn.small} onClick={logout}>Log out</button>
            </>
          ) : (
            <>
              <button className={btn.small} onClick={() => setAuthModal('login')}>Sign in</button>
              <button className={btn.primary} onClick={() => setAuthModal('register')}>Sign up</button>
            </>
          )}
        </div>
      </header>

      {authModal && (
        <div className="modal-backdrop" onClick={() => setAuthModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{authModal === 'login' ? 'Sign in' : 'Create account'}</h3>
            <form onSubmit={submitAuth} className="auth-form">
              {authModal === 'register' && (
                <label className="field">Name
                  <input value={authForm.name} onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })} placeholder="Sujal" />
                </label>
              )}
              <label className="field">Email
                <input type="email" required value={authForm.email} onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })} placeholder="you@example.com" />
              </label>
              <label className="field">Password
                <input type="password" required minLength={6} value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} placeholder="6+ characters" />
              </label>
              <div className="actions">
                <button type="submit" className={btn.primary} disabled={authBusy}>
                  {authBusy ? '…' : authModal === 'login' ? 'Sign in' : 'Create account'}
                </button>
                <button type="button" className={btn.secondary} onClick={() => setAuthModal(authModal === 'login' ? 'register' : 'login')}>
                  {authModal === 'login' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {user && (
        <section className="card account-panel">
          <h2>My account</h2>
          <p className="muted">{user.name} · {user.email}</p>
          <h3>Connected accounts</h3>
          <div className="connections">
            {platforms.map((p) => {
              const conn = connections.find((c) => c.platform === p.id);
              return (
                <div key={p.id} className="connection-row">
                  <span className="conn-label">{p.label}</span>
                  {conn ? (
                    <>
                      <Pill tone="good">✅ Connected{conn.username ? ` — ${conn.username}` : ''}</Pill>
                      <button className={btn.small} onClick={() => disconnectPlatform(p.id)}>Disconnect</button>
                    </>
                  ) : (
                    <>
                      <Pill tone="neutral">❌ Not connected</Pill>
                      <button className={btn.small} onClick={() => connectPlatform(p.id)}>Connect</button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <p className="muted small">
            Connecting retains sample posts into <em>your</em> memory (tagged user + platform);
            recommendations and A/B winners are then scoped to your account.
          </p>
        </section>
      )}

      <main className="grid">
        {/* LEFT: composer */}
        <section className="card">
          <h2>1 · Composer</h2>
          <label className="field">
            Channel
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="linkedin">LinkedIn</option>
              <option value="x">X / Twitter</option>
              <option value="instagram">Instagram</option>
              <option value="facebook">Facebook</option>
              <option value="youtube">YouTube</option>
              <option value="pinterest">Pinterest</option>
              <option value="reddit">Reddit</option>
              <option value="telegram">Telegram</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </label>
          <button className={btn.primary} onClick={recommend} disabled={loadingRec}>
            {loadingRec ? 'Recalling memory…' : '✨ Recommend (memory-informed)'}
          </button>

          {rec && (
            <div className="provenance">
              <strong>Why:</strong> {rec.why || '—'}
              <div className="examples">
                {(rec.examples || []).map((e) => (
                  <div key={String(e.post_id)} className="example">
                    <Pill tone="good">{e.ctr}% {e.metric || 'CTR'}</Pill> <code>{e.platform || 'post'} #{e.post_id}</code> {e.text?.slice(0, 70)}
                    {e.text?.length > 70 ? '…' : ''}
                  </div>
                ))}
              </div>
              <small className="source">
                source: {rec.source}
                {memoryInformed ? '' : ' · import seed data to make this fully memory-driven'}
              </small>
            </div>
          )}

          <label className="field">
            Hook A <span className="hint">(memory-informed)</span>
            <textarea
              rows={2}
              value={form.hook}
              onChange={(e) => setForm({ ...form, hook: e.target.value })}
              placeholder="Click Recommend to generate"
            />
          </label>
          <label className="field">
            Hook B <span className="hint">(generic / technical control)</span>
            <textarea
              rows={2}
              value={form.hook_b}
              onChange={(e) => setForm({ ...form, hook_b: e.target.value })}
              placeholder="Generated with Hook A"
            />
          </label>
          <label className="field">
            Caption
            <textarea rows={3} value={form.caption} onChange={(e) => setForm({ ...form, caption: e.target.value })} />
          </label>
          <label className="field">
            Hashtags
            <input value={form.hashtags} onChange={(e) => setForm({ ...form, hashtags: e.target.value })} />
          </label>
          <label className="field">
            Suggested best time
            <input value={form.best_time} onChange={(e) => setForm({ ...form, best_time: e.target.value })} />
          </label>
        </section>

        {/* CENTER: approval + scheduler */}
        <section className="card">
          <h2>2 · Approve & schedule</h2>
          <label className="approve">
            <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
            <span>
              Human approval <span className="hint">— required before anything is scheduled</span>
            </span>
          </label>

          <label className="field">
            Schedule time <span className="hint">(optional; defaults to +48h)</span>
            <input
              type="datetime-local"
              value={form.schedule_time}
              onChange={(e) => setForm({ ...form, schedule_time: e.target.value })}
            />
          </label>

          <div className="actions">
            <button className={btn.secondary} onClick={createAb}>
              Create A/B test
            </button>
            <button className={btn.secondary} onClick={() => schedule('A')} disabled={!abId || scheduledA}>
              {scheduledA ? '✓ A scheduled' : 'Schedule A'}
            </button>
            <button className={btn.secondary} onClick={() => schedule('B')} disabled={!abId || scheduledB}>
              {scheduledB ? '✓ B scheduled' : 'Schedule B'}
            </button>
          </div>
          {abId && <code className="ab-id">ab_id: {abId}</code>}

          <button className={btn.primary} onClick={fetchResults} disabled={loadingResults || !abId}>
            {loadingResults ? 'Simulating 48h…' : '📊 Fetch A/B results (simulated)'}
          </button>

          {abResults && (
            <div className="results">
              <h3>
                Winner: {abResults.results.winner}{' '}
                <span className="uplift">
                  {abResults.results.uplift}× CTR uplift
                </span>
              </h3>
              <table>
                <thead>
                  <tr>
                    <th />
                    <th>Impressions</th>
                    <th>Clicks</th>
                    <th>CTR</th>
                    <th>Likes</th>
                    <th>Comments</th>
                  </tr>
                </thead>
                <tbody>
                  {['A', 'B'].map((v) => (
                    <tr key={v} className={abResults.results.winner === v ? 'winner-row' : ''}>
                      <td>
                        {v} {v === 'A' ? '(memory-informed)' : '(control)'}
                      </td>
                      <td>{abResults.results[v].impressions}</td>
                      <td>{abResults.results[v].clicks}</td>
                      <td>{abResults.results[v].ctr}%</td>
                      <td>{abResults.results[v].likes}</td>
                      <td>{abResults.results[v].comments}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {abResults.memory_writeback ? (
                <div className="writeback">
                  <strong>Memory writeback ✓</strong>
                  <div className="writeback-text">“{abResults.memory_writeback.metadata?.hook}”</div>
                  <small>
                    tags: {(abResults.memory_writeback.tags || []).join(', ')} · stored in Hindsight bank{' '}
                    {abResults.memory_writeback.metadata?.ab_id ? `(ab ${abResults.memory_writeback.metadata.ab_id})` : ''}
                  </small>
                </div>
              ) : (
                <div className="writeback warn">
                  Control won this run — no memory writeback for the losing hook.
                </div>
              )}
            </div>
          )}
        </section>

        {/* RIGHT: dashboard */}
        <section className="card">
          <h2>3 · Memory & comments</h2>
          <div className="mem-summary">
            <Pill tone={memory?.mode === 'hindsight' ? 'good' : 'warn'}>
              {memory?.mode || 'memory'} · {memory?.total ?? 0} memories
            </Pill>
            <Pill tone="good">{memory?.top_hooks?.length || 0} winning hooks</Pill>
          </div>

          <h3>Top hooks learned (Hindsight)</h3>
          <div className="hooks">
            {(memory?.top_hooks || []).length === 0 && (
              <p className="empty">None yet — run the A/B flow and the winning hook will be saved here.</p>
            )}
            {(memory?.top_hooks || []).map((h) => (
              <div key={h.id || h.text} className="hook">
                “{h.metadata?.hook || h.text}”
                <small>
                  {h.metadata?.ctr_percent ? `${h.metadata.ctr_percent}% CTR · ` : ''}
                  {h.metadata?.uplift ? `${h.metadata.uplift}× uplift · ` : ''}
                  {h.metadata?.ab_id ? `ab ${h.metadata.ab_id}` : ''}
                </small>
              </div>
            ))}
          </div>

          <h3>Comments (click for reply suggestion)</h3>
          <div className="comments">
            {comments.slice(0, 8).map((c) => (
              <button key={c.comment_id} className="comment" onClick={() => openCommentModal(c)}>
                <span className="comment-user">{c.user}</span>
                <span className="comment-text">{c.text}</span>
                <Pill tone={c.tag === 'bug' ? 'warn' : c.tag === 'praise' ? 'good' : 'neutral'}>{c.tag}</Pill>
              </button>
            ))}
          </div>
        </section>
      </main>

      {modalComment && (
        <div className="modal-backdrop" onClick={() => setModalComment(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Reply suggestion</h3>
            <p className="modal-comment">“{modalComment.text}” — <strong>{modalComment.user}</strong></p>
            <Pill tone="neutral">tag: {modalLoading ? '…' : modalTag}</Pill>
            {modalLoading ? (
              <p>Recalling similar comments from memory…</p>
            ) : (
              <textarea
                rows={4}
                value={modalReply}
                onChange={(e) => setModalReply(e.target.value)}
              />
            )}
            <div className="actions">
              <button className={btn.primary} onClick={() => { showToast('Reply approved and applied ✓'); setModalComment(null); }}>
                Approve & apply
              </button>
              <button className={btn.secondary} onClick={() => setModalComment(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      <footer className="footer">
        Demo flow: Import CSV → Recommend → Approve → Create A/B → Schedule A+B → Fetch results → memory writeback.
        Import first: <code>curl -X POST http://localhost:4000/api/import</code>
      </footer>
    </div>
  );
}
