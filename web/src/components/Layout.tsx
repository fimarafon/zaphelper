import clsx from "clsx";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useLogout, useMe } from "../api/hooks";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/messages", label: "Messages" },
  { to: "/commands", label: "Commands" },
  { to: "/reminders", label: "Reminders" },
  { to: "/schedules", label: "Schedules" },
  { to: "/delegates", label: "Delegates" },
];

export function Layout() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout.mutateAsync();
    navigate("/login");
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2">
              <span className="text-xl">💬</span>
              <span className="font-semibold tracking-tight">zaphelper</span>
            </div>
            <nav className="flex items-center gap-1">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    clsx(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-brand-50 text-brand-700"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <span>{me.data?.user?.username}</span>
            <button
              onClick={handleLogout}
              disabled={logout.isPending}
              className="btn-secondary text-xs"
            >
              Sair
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
