import { useEffect, useState } from "react";
import { supabase } from "./lib/supabaseClient";

const G = {
  dark: "#1A3A2A",
  mid: "#2D6A4F",
  light: "#52B788",
  gold: "#D4A017",
  cream: "#FDF8EE",
  ink: "#1C1C1E",
  muted: "#6B7280",
  card: "#FFFFFF",
  red: "#DC2626",
};

export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage("");
    setBusy(true);

    if (!email || !password) {
      setMessage("Enter your email and password.");
      setBusy(false);
      return;
    }

    if (password.length < 6) {
      setMessage("Password must be at least 6 characters.");
      setBusy(false);
      return;
    }

    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin,
          },
        });

        if (error) throw error;

        setMessage("Account created. Check your email to confirm your account, then log in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (error) throw error;

        setMessage("Logged in.");
      }
    } catch (err) {
      setMessage(err.message || "Something went wrong.");
    }

    setBusy(false);
  };

  const logout = async () => {
    await supabase.auth.signOut();
  };

  if (loading) {
    return (
      <div style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: G.cream,
        color: G.dark,
        fontFamily: "Inter, system-ui, sans-serif",
        fontWeight: 700,
      }}>
        Loading...
      </div>
    );
  }

  if (!session) {
    return (
      <div style={{
        minHeight: "100vh",
        background: `linear-gradient(135deg, ${G.dark}, ${G.mid})`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        fontFamily: "Inter, system-ui, sans-serif",
      }}>
        <div style={{
          width: "100%",
          maxWidth: 430,
          background: G.card,
          borderRadius: 22,
          padding: 32,
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
          borderTop: `6px solid ${G.gold}`,
        }}>
          <div style={{ marginBottom: 24 }}>
            <div style={{
              fontSize: 13,
              fontWeight: 800,
              color: G.gold,
              letterSpacing: 1,
              textTransform: "uppercase",
              marginBottom: 8,
            }}>
              Kaziranga Profit Tracker
            </div>

            <h1 style={{
              margin: 0,
              fontSize: 30,
              color: G.dark,
              lineHeight: 1.1,
            }}>
              {mode === "login" ? "Log in" : "Create account"}
            </h1>

            <p style={{
              marginTop: 10,
              color: G.muted,
              fontSize: 14,
              lineHeight: 1.5,
            }}>
              {mode === "login"
                ? "Log in to view your private profit dashboard."
                : "Create an account so your CSV data can be saved to your own account."}
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            <label style={{ fontSize: 13, fontWeight: 700, color: G.dark }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={{
                width: "100%",
                boxSizing: "border-box",
                marginTop: 6,
                marginBottom: 16,
                padding: "12px 14px",
                borderRadius: 10,
                border: "1px solid #D1D5DB",
                fontSize: 15,
              }}
            />

            <label style={{ fontSize: 13, fontWeight: 700, color: G.dark }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              style={{
                width: "100%",
                boxSizing: "border-box",
                marginTop: 6,
                marginBottom: 18,
                padding: "12px 14px",
                borderRadius: 10,
                border: "1px solid #D1D5DB",
                fontSize: 15,
              }}
            />

            <button
              type="submit"
              disabled={busy}
              style={{
                width: "100%",
                padding: "13px 16px",
                borderRadius: 12,
                border: "none",
                background: busy ? "#9CA3AF" : G.dark,
                color: "#fff",
                fontSize: 15,
                fontWeight: 800,
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              {busy
                ? "Please wait..."
                : mode === "login"
                  ? "Log in"
                  : "Create account"}
            </button>
          </form>

          {message && (
            <div style={{
              marginTop: 16,
              padding: "10px 12px",
              borderRadius: 10,
              background: "#F3F4F6",
              color: message.toLowerCase().includes("error") || message.toLowerCase().includes("invalid")
                ? G.red
                : G.dark,
              fontSize: 13,
              lineHeight: 1.4,
            }}>
              {message}
            </div>
          )}

          <div style={{
            marginTop: 22,
            fontSize: 14,
            color: G.muted,
            textAlign: "center",
          }}>
            {mode === "login" ? "Need an account?" : "Already have an account?"}{" "}
            <button
              type="button"
              onClick={() => {
                setMode(mode === "login" ? "signup" : "login");
                setMessage("");
              }}
              style={{
                background: "transparent",
                border: "none",
                color: G.mid,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              {mode === "login" ? "Sign up" : "Log in"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div style={{
        background: G.dark,
        color: "#fff",
        padding: "10px 18px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 13,
      }}>
        <div>
          Logged in as <strong>{session.user.email}</strong>
        </div>

        <button
          onClick={logout}
          style={{
            background: G.gold,
            color: G.dark,
            border: "none",
            borderRadius: 8,
            padding: "7px 12px",
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          Log out
        </button>
      </div>

      {children}
    </>
  );
}