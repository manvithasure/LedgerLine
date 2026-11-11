import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type User = { id: string; email: string; displayName: string; role: "ADMIN" | "HOLDER" | "AUDITOR" };
type Account = { id: string; name: string; ownerName: string; balanceCents: number };
type Entry = {
  id: number;
  entryType: "DEBIT" | "CREDIT" | "REFUSED";
  amountCents: number;
  balanceAfterCents: number;
  description: string;
  actorName: string;
  createdAt: string;
};
type UserOption = { id: string; email: string; displayName: string; role: User["role"] };

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

function money(cents: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(cents / 100);
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init?.headers
    }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Something went wrong.");
  return body as T;
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("ledgerline-token") ?? "");
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [loginEmail, setLoginEmail] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [recipients, setRecipients] = useState<Account[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [activeTab, setActiveTab] = useState<"overview" | "activity">("overview");
  const [movementType, setMovementType] = useState<"TRANSFER" | "WITHDRAWAL" | "DEPOSIT">("TRANSFER");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const retryKey = useRef<{ fingerprint: string; key: string } | null>(null);

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId),
    [accounts, selectedAccountId]
  );

  const loadData = useCallback(async (currentToken: string) => {
    const [me, accountData] = await Promise.all([
      request<{ user: User }>("/me", currentToken),
      request<{ accounts: Account[] }>("/accounts", currentToken)
    ]);
    setUser(me.user);
    const visibleAccounts = accountData.accounts;
    setAccounts(visibleAccounts);
    setSelectedAccountId((existing) =>
      visibleAccounts.some((account) => account.id === existing)
        ? existing
        : visibleAccounts[0]?.id ?? ""
    );
    if (me.user.role === "HOLDER") {
      const recipientData = await request<{ recipients: Account[] }>("/recipients", currentToken);
      setRecipients(recipientData.recipients);
    } else {
      setRecipients(visibleAccounts);
    }
    if (me.user.role === "ADMIN") {
      const userData = await request<{ users: UserOption[] }>("/users", currentToken);
      setUsers(userData.users);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    loadData(token).catch((loadError: Error) => {
      localStorage.removeItem("ledgerline-token");
      setToken("");
      setUser(null);
      setError(loadError.message);
    });
  }, [token, loadData]);

  useEffect(() => {
    if (!token || !selectedAccountId || !accounts.some((account) => account.id === selectedAccountId)) return;
    request<{ entries: Entry[] }>(`/accounts/${selectedAccountId}/statement`, token)
      .then((data) => setEntries(data.entries))
      .catch((loadError: Error) => setError(loadError.message));
  }, [token, selectedAccountId, accounts]);

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") })
      });
      const body = await result.json();
      if (!result.ok) throw new Error(body.error ?? "Sign in failed.");
      localStorage.setItem("ledgerline-token", body.token);
      setToken(body.token);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Sign in failed.");
    } finally {
      setLoading(false);
    }
  }

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setAuthNotice("");
    setLoading(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email")).trim().toLowerCase();
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          displayName: form.get("displayName"),
          password: form.get("password")
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Registration failed.");
      setLoginEmail(email);
      setAuthMode("login");
      setAuthNotice("Registration complete. An administrator must create your account before you can sign in.");
    } catch (registrationError) {
      setError(registrationError instanceof Error ? registrationError.message : "Registration failed.");
    } finally {
      setLoading(false);
    }
  }

  function signOut() {
    localStorage.removeItem("ledgerline-token");
    setToken("");
    setUser(null);
    setAccounts([]);
    setRecipients([]);
    setUsers([]);
    setEntries([]);
    setSelectedAccountId("");
    setError("");
    setMessage("");
  }

  async function moveMoney(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAccount || !user) return;
    const formElement = event.currentTarget;
    setError("");
    setMessage("");
    setLoading(true);
    const form = new FormData(formElement);
    const movement = String(form.get("movement"));
    const amountCents = Math.round(Number(form.get("amount")) * 100);
    const body: Record<string, unknown> = {
      accountId: selectedAccount.id,
      amountCents,
      description: String(form.get("description") || "")
    };
    if (movement === "TRANSFER") body.destinationAccountId = String(form.get("destinationAccountId"));
    const path = `/movements/${movement === "WITHDRAWAL" ? "withdraw" : movement.toLowerCase()}`;
    const fingerprint = JSON.stringify({ path, body });
    if (retryKey.current?.fingerprint !== fingerprint) {
      retryKey.current = { fingerprint, key: crypto.randomUUID() };
    }

    try {
      const result = await request<{ status: string; error?: string; amountCents?: number }>(
        path,
        token,
        {
          method: "POST",
          headers: { "Idempotency-Key": retryKey.current.key },
          body: JSON.stringify(body)
        }
      );
      retryKey.current = null;
      setMovementType("TRANSFER");
      setMessage(`${movement === "TRANSFER" ? "Transfer" : movement.toLowerCase()} complete: ${money(result.amountCents ?? amountCents)}.`);
      await loadData(token);
      setEntries((await request<{ entries: Entry[] }>(
        `/accounts/${selectedAccount.id}/statement`,
        token
      )).entries);
      formElement.reset();
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "Money movement failed.");
      const refreshed = await request<{ entries: Entry[] }>(
        `/accounts/${selectedAccount.id}/statement`,
        token
      ).catch(() => ({ entries: [] }));
      setEntries(refreshed.entries);
    } finally {
      setLoading(false);
    }
  }

  async function createAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setError("");
    setMessage("");
    setLoading(true);
    const form = new FormData(formElement);
    try {
      await request("/accounts", token, {
        method: "POST",
        body: JSON.stringify({
          name: String(form.get("name")),
          ownerUserId: String(form.get("ownerUserId"))
        })
      });
      setMessage("Account created with a zero balance.");
      formElement.reset();
      await loadData(token);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create account.");
    } finally {
      setLoading(false);
    }
  }

  async function createUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setError("");
    setMessage("");
    setLoading(true);
    const form = new FormData(formElement);
    try {
      await request("/users", token, {
        method: "POST",
        body: JSON.stringify({
          email: String(form.get("email")),
          displayName: String(form.get("displayName")),
          role: String(form.get("role")),
          password: String(form.get("password"))
        })
      });
      setMessage("User created. You can now assign an account to them.");
      formElement.reset();
      await loadData(token);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create user.");
    } finally {
      setLoading(false);
    }
  }

  if (!user) {
    return (
      <main className="login-page">
        <div className="login-brand"><span className="brand-mark">L</span><span>LedgerLine</span></div>
        <section className="login-card">
          <div className="eyebrow">MONEY, ACCOUNTED FOR</div>
          <h1>{authMode === "login" ? "Welcome back." : "Create your account."}</h1>
          <p className="muted">{authMode === "login" ? "A clear view of every rupee, every time." : "Register as an account holder. An administrator will set up your account."}</p>
          {authNotice && <div className="notice success">{authNotice}</div>}
          <form onSubmit={authMode === "login" ? signIn : register} className="form-stack">
            {authMode === "register" && <label>Full name<input name="displayName" type="text" maxLength={120} autoComplete="name" required /></label>}
            <label>Email address<input name="email" type="email" maxLength={254} autoComplete="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} required /></label>
            <label>Password<input name="password" type="password" minLength={authMode === "register" ? 12 : undefined} maxLength={72} autoComplete={authMode === "login" ? "current-password" : "new-password"} required /></label>
            {error && <div className="notice error">{error}</div>}
            <button className="button primary wide" disabled={loading}>{loading ? (authMode === "login" ? "Signing in..." : "Creating account...") : (authMode === "login" ? "Sign in" : "Register")} <span>→</span></button>
          </form>
          <div className="auth-switch">
            {authMode === "login" ? "New to LedgerLine?" : "Already registered?"}
            <button type="button" onClick={() => { setError(""); setAuthNotice(""); setAuthMode(authMode === "login" ? "register" : "login"); }}>
              {authMode === "login" ? "Create an account" : "Sign in"}
            </button>
          </div>
        </section>
        <div className="login-footer">Built for money that always adds up.</div>
      </main>
    );
  }

  const totalBalance = accounts.reduce((sum, account) => sum + account.balanceCents, 0);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#"><span className="brand-mark">L</span><span>LedgerLine</span></a>
        <div className="side-label">WORKSPACE</div>
        <button className={`side-link ${activeTab === "overview" ? "selected" : ""}`} onClick={() => setActiveTab("overview")}><span>▦</span> Overview</button>
        <button className={`side-link ${activeTab === "activity" ? "selected" : ""}`} onClick={() => setActiveTab("activity")}><span>↕</span> Activity</button>
        <div className="sidebar-bottom">
          <div className="security-note"><span className="secure-dot" /> Ledger verified<br /><small>Every movement is recorded</small></div>
          <button className="profile" onClick={signOut}>
            <span className="avatar">{user.displayName.slice(0, 1)}</span>
            <span className="profile-name">{user.displayName}<small>{user.role.toLowerCase()}</small></span>
            <span className="signout">↗</span>
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><div className="eyebrow">YOUR FINANCES</div><h1>{activeTab === "overview" ? "Overview" : "Account activity"}</h1></div>
          <div className="topbar-right">
            <span className="live-dot" /> <span className="system-status">All systems operational</span>
            <span className="top-divider" />
            <span className="date">{new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
            <button className="topbar-signout" onClick={signOut}>Sign out</button>
          </div>
        </header>

        <div className="content">
          {error && <div className="notice error">{error}<button onClick={() => setError("")}>×</button></div>}
          {message && <div className="notice success">{message}<button onClick={() => setMessage("")}>×</button></div>}

          <section className="summary-grid">
            <article className="balance-card">
              <div className="card-overline">TOTAL ACCOUNT BALANCE <span className="balance-icon">₹</span></div>
              <div className="balance-value">{money(totalBalance)}</div>
              <div className="balance-caption"><span className="secure-dot" /> Across {accounts.length} account{accounts.length === 1 ? "" : "s"} · balances update instantly</div>
              <div className="card-decoration decoration-one" /><div className="card-decoration decoration-two" />
            </article>
            <article className="mini-card">
              <div className="mini-card-head"><span>ACCOUNTS</span><span className="mini-icon">▣</span></div>
              <div className="mini-value">{accounts.length}</div>
              <div className="mini-foot">Active accounts</div>
            </article>
            <article className="mini-card">
              <div className="mini-card-head"><span>RECENT MOVEMENTS</span><span className="mini-icon">↕</span></div>
              <div className="mini-value">{entries.length}</div>
              <div className="mini-foot">On selected account</div>
            </article>
          </section>

          <section className="section-heading"><div><div className="eyebrow">ACCOUNT MANAGEMENT</div><h2>Your accounts</h2></div></section>
          <div className="account-grid">
            {accounts.map((account) => (
              <button key={account.id} className={`account-card ${selectedAccountId === account.id ? "account-selected" : ""}`} onClick={() => setSelectedAccountId(account.id)}>
                <div className="account-top"><span className="account-icon">↗</span><span className="account-arrow">↗</span></div>
                <div className="account-name">{account.name}</div>
                <div className="account-owner">{account.ownerName}{user.role !== "HOLDER" && ` · ${account.id.slice(0, 8)}`}</div>
                <div className="account-balance">{money(account.balanceCents)}</div>
                <div className="account-bottom"><span>Available balance</span><span className="account-status">● Active</span></div>
              </button>
            ))}
            {!accounts.length && (
              <div className="empty-account">
                {user.role === "ADMIN"
                  ? "No accounts yet. Create a user and account below to get started."
                  : "No account has been assigned to you yet. Ask your administrator to create one, then you can fund it with a demo deposit."}
              </div>
            )}
          </div>

          {user.role === "AUDITOR" && (
            <div className="notice auditor-note">
              <span><strong>Read-only auditor access.</strong> You can inspect accounts and ledger entries, but cannot move money.</span>
            </div>
          )}

          {activeTab === "overview" && user.role === "ADMIN" && (
            <>
            <section className="movement-panel">
              <div className="movement-title"><div><div className="eyebrow">ADMINISTRATION</div><h2>Create a user</h2></div></div>
              <form className="movement-form" onSubmit={createUser}>
                <label>Full name<input name="displayName" maxLength={120} placeholder="e.g. Jordan Smith" required /></label>
                <label>Email address<input name="email" type="email" maxLength={254} placeholder="name@example.com" required /></label>
                <label>Role<select name="role" defaultValue="HOLDER"><option value="HOLDER">Account holder</option><option value="AUDITOR">Auditor (read-only)</option><option value="ADMIN">Administrator</option></select></label>
                <label>Password<input name="password" type="password" minLength={12} autoComplete="new-password" placeholder="At least 12 characters" required /></label>
                <button className="button primary submit-button" disabled={loading}>{loading ? "Creating..." : "Create user"} <span>→</span></button>
                <p className="form-footnote">Passwords are stored as salted bcrypt hashes. Share credentials securely.</p>
              </form>
            </section>
            <section className="movement-panel">
              <div className="movement-title"><div><div className="eyebrow">ADMINISTRATION</div><h2>Create an account</h2></div></div>
              <form className="movement-form" onSubmit={createAccount}>
                <label>Account name<input name="name" maxLength={120} placeholder="e.g. Operations account" required /></label>
                <label>Account owner<select name="ownerUserId" required defaultValue=""><option value="" disabled>Choose a user…</option>{users.filter((option) => option.role !== "AUDITOR").map((option) => <option value={option.id} key={option.id}>{option.displayName} · {option.email}</option>)}</select></label>
                <button className="button primary submit-button" disabled={loading}>{loading ? "Creating..." : "Create account"} <span>→</span></button>
              </form>
            </section>
            </>
          )}

          {activeTab === "overview" && user.role !== "AUDITOR" && accounts.length > 0 && (
            <section className="movement-panel">
              <div className="movement-title"><div><div className="eyebrow">MOVE MONEY</div><h2>Make a movement</h2></div><div className="locked-label">⌑ Secure transaction</div></div>
              <form className="movement-form" onSubmit={moveMoney}>
                <label>Movement type<select name="movement" value={movementType} onChange={(event) => setMovementType(event.target.value as typeof movementType)}><option value="TRANSFER">Transfer to account</option><option value="WITHDRAWAL">Withdraw</option><option value="DEPOSIT">Demo deposit</option></select></label>
                <label>{movementType === "DEPOSIT" ? "Deposit into account" : "From account"}<select name="source" value={selectedAccountId} onChange={(event) => setSelectedAccountId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} — {money(account.balanceCents)}</option>)}</select></label>
                {movementType === "TRANSFER" && <MovementFields recipients={recipients.filter((recipient) => recipient.id !== selectedAccountId)} />}
                <label>Amount (₹)<input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required /></label>
                <label className="full-field">{movementType === "DEPOSIT" ? "Deposit note" : "Description"} <span className="optional">(optional)</span><input name="description" maxLength={255} placeholder={movementType === "DEPOSIT" ? "Demo funds added for testing" : "What is this payment for?"} /></label>
                <button className="button primary submit-button" disabled={loading || !accounts.length}>{loading ? "Processing securely..." : "Review & submit"} <span>→</span></button>
                <p className="form-footnote">{movementType === "DEPOSIT" ? "Demo deposit only: records simulated external money. No real payment is processed." : "Each request is processed once and recorded permanently in the ledger."}</p>
              </form>
            </section>
          )}

          <section className="activity-panel">
            <div className="activity-heading"><div><div className="eyebrow">ACCOUNT STATEMENT</div><h2>{selectedAccount?.name ?? "Recent activity"}</h2></div><span className="records-count">{entries.length} records</span></div>
            <div className="table-scroll">
              <table>
                <thead><tr><th>ACTIVITY</th><th>INITIATED BY</th><th>DATE & TIME</th><th>AMOUNT</th><th>BALANCE AFTER</th></tr></thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td><span className={`entry-icon ${entry.entryType.toLowerCase()}`}>{entry.entryType === "CREDIT" ? "↙" : entry.entryType === "REFUSED" ? "!" : "↗"}</span><span className="entry-label">{entry.description}<small>{entry.entryType.toLowerCase()}</small></span></td>
                      <td>{entry.actorName}</td>
                      <td>{new Date(entry.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</td>
                      <td className={entry.entryType === "CREDIT" ? "positive" : entry.entryType === "REFUSED" ? "refused" : ""}>{entry.entryType === "CREDIT" ? "+" : entry.entryType === "DEBIT" ? "−" : "!"}{money(entry.amountCents)}</td>
                      <td>{money(entry.balanceAfterCents)}</td>
                    </tr>
                  ))}
                  {!entries.length && <tr><td className="empty-row" colSpan={5}>No activity yet. Account movements will appear here.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <footer className="page-footer"><span>LedgerLine · Your books, always balanced.</span><span>Transactions are protected by database-level locking.</span></footer>
        </div>
      </main>
    </div>
  );
}

function MovementFields({ recipients }: { recipients: Account[] }) {
  return (
    <label>To account <select name="destinationAccountId" required><option value="">Choose recipient…</option>{recipients.map((recipient) => <option value={recipient.id} key={recipient.id}>{recipient.name} · {recipient.id.slice(0, 8)}</option>)}</select></label>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
