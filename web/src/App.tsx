import { Navigate, Route, Routes } from "react-router-dom";
import { useMe } from "./api/hooks";
import { Layout } from "./components/Layout";
import { Commands } from "./pages/Commands";
import { Dashboard } from "./pages/Dashboard";
import { Delegates } from "./pages/Delegates";
import { Login } from "./pages/Login";
import { Messages } from "./pages/Messages";
import { Reminders } from "./pages/Reminders";
import { Schedules } from "./pages/Schedules";

export function App() {
  const meQuery = useMe();

  if (meQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">
        Loading…
      </div>
    );
  }

  const isAuthed = Boolean(meQuery.data?.user);

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthed ? <Navigate to="/" replace /> : <Login />}
      />
      <Route
        element={isAuthed ? <Layout /> : <Navigate to="/login" replace />}
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/messages" element={<Messages />} />
        <Route path="/commands" element={<Commands />} />
        <Route path="/reminders" element={<Reminders />} />
        <Route path="/schedules" element={<Schedules />} />
        <Route path="/delegates" element={<Delegates />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
