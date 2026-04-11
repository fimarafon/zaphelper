import { useState } from "react";
import { useLogin } from "../api/hooks";

export function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useLogin();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login.mutateAsync({ username, password });
    } catch {
      // error shown below
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-3xl">💬</div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">zaphelper</h1>
          <p className="mt-1 text-sm text-slate-500">Seu assistente pessoal no WhatsApp</p>
        </div>
        <form onSubmit={onSubmit} className="card space-y-4">
          <div>
            <label className="label" htmlFor="username">
              Usuário
            </label>
            <input
              id="username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Senha
            </label>
            <input
              id="password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {login.error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
              {(login.error as Error).message}
            </div>
          )}
          <button type="submit" className="btn-primary w-full" disabled={login.isPending}>
            {login.isPending ? "Entrando…" : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
