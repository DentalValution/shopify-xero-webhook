'use client';

import { useState } from 'react';

export default function RetryAdminPage() {
  const [secret, setSecret] = useState('');
  const [authed, setAuthed] = useState(false);
  const [failures, setFailures] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retryingKey, setRetryingKey] = useState(null);
  const [retryingAll, setRetryingAll] = useState(false);
  const [lastResult, setLastResult] = useState(null);

  async function loadFailures() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/retry-failed-orders', {
        headers: { 'x-admin-secret': secret },
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to load');
        setAuthed(false);
      } else {
        setFailures(data.failures || []);
        setAuthed(true);
      }
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }

  async function retryOne(key) {
    setRetryingKey(key);
    setLastResult(null);
    try {
      const res = await fetch('/api/retry-failed-orders', {
        method: 'POST',
        headers: { 'x-admin-secret': secret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      setLastResult(data);
      await loadFailures();
    } catch (e) {
      setError(e.message);
    }
    setRetryingKey(null);
  }

  async function retryAll() {
    setRetryingAll(true);
    setLastResult(null);
    try {
      const res = await fetch('/api/retry-failed-orders', {
        method: 'POST',
        headers: { 'x-admin-secret': secret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ retryAll: true }),
      });
      const data = await res.json();
      setLastResult(data);
      await loadFailures();
    } catch (e) {
      setError(e.message);
    }
    setRetryingAll(false);
  }

  const styles = {
    page: { maxWidth: 900, margin: '40px auto', padding: '0 20px', fontFamily: 'system-ui, sans-serif' },
    input: { padding: '10px 14px', fontSize: 15, border: '1px solid #ccc', borderRadius: 6, width: 280 },
    button: {
      padding: '10px 18px',
      fontSize: 15,
      border: 'none',
      borderRadius: 6,
      background: '#1a73e8',
      color: 'white',
      cursor: 'pointer',
      marginLeft: 10,
    },
    buttonDanger: { background: '#d93025' },
    buttonSmall: {
      padding: '6px 12px',
      fontSize: 13,
      border: 'none',
      borderRadius: 5,
      background: '#1a73e8',
      color: 'white',
      cursor: 'pointer',
    },
    card: {
      border: '1px solid #e0e0e0',
      borderRadius: 8,
      padding: 16,
      marginBottom: 12,
      background: '#fafafa',
    },
    errorText: { color: '#d93025', marginTop: 10 },
    badge: {
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 12,
      fontWeight: 600,
      marginLeft: 8,
    },
  };

  if (!authed) {
    return (
      <div style={styles.page}>
        <h1>Retry Failed Orders</h1>
        <p>Enter the admin secret to view and retry failed Shopify → Xero orders.</p>
        <input
          type="password"
          placeholder="Admin secret"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          style={styles.input}
          onKeyDown={(e) => e.key === 'Enter' && loadFailures()}
        />
        <button style={styles.button} onClick={loadFailures} disabled={loading}>
          {loading ? 'Checking...' : 'Unlock'}
        </button>
        {error && <p style={styles.errorText}>{error}</p>}
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <h1>Failed Orders</h1>
      <p>{failures.length} failure(s) recorded.</p>

      <div style={{ marginBottom: 20 }}>
        <button style={styles.button} onClick={loadFailures} disabled={loading}>
          🔄 Refresh
        </button>
        <button
          style={{ ...styles.button, ...styles.buttonDanger }}
          onClick={retryAll}
          disabled={retryingAll || failures.length === 0}
        >
          {retryingAll ? 'Retrying all...' : 'Retry All'}
        </button>
      </div>

      {lastResult && (
        <div style={{ ...styles.card, background: '#e8f5e9', marginBottom: 20 }}>
          <strong>Last retry result:</strong> {lastResult.succeeded ?? 0} succeeded,{' '}
          {lastResult.failed ?? 0} failed, {lastResult.skipped ?? 0} skipped (already retried)
        </div>
      )}

      {failures.length === 0 && <p>No failures recorded. Everything's running clean. 🎉</p>}

      {failures.map((f) => (
        <div key={f.key} style={styles.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>{f.orderNumber}</strong>
              <span
                style={{
                  ...styles.badge,
                  background: f.retried ? '#c8e6c9' : '#ffcdd2',
                  color: f.retried ? '#1b5e20' : '#b71c1c',
                }}
              >
                {f.retried ? 'Retried' : 'Pending'}
              </span>
            </div>
            <button
              style={styles.buttonSmall}
              onClick={() => retryOne(f.key)}
              disabled={retryingKey === f.key || f.retried}
            >
              {retryingKey === f.key ? 'Retrying...' : f.retried ? 'Done' : 'Retry'}
            </button>
          </div>
          <p style={{ fontSize: 13, color: '#666', margin: '8px 0 4px' }}>
            {f.customerEmail} · {new Date(f.timestamp).toLocaleString()}
          </p>
          <p style={{ fontSize: 13, color: '#b71c1c', margin: 0 }}>{f.errorMessage}</p>
        </div>
      ))}
    </div>
  );
}
