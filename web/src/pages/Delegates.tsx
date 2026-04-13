import { useState } from "react";
import {
  useAddDelegate,
  useDeleteDelegate,
  useDelegates,
  useToggleDelegate,
} from "../api/hooks";

export function Delegates() {
  const delegates = useDelegates();
  const addDelegate = useAddDelegate();
  const toggleDelegate = useToggleDelegate();
  const deleteDelegate = useDeleteDelegate();

  const [showForm, setShowForm] = useState(false);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone.trim() || !name.trim()) return;
    await addDelegate.mutateAsync({ phone: phone.trim(), name: name.trim() });
    setPhone("");
    setName("");
    setShowForm(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Delegates</h2>
          <p className="text-sm text-slate-500">
            People authorized to run commands by DM'ing you on WhatsApp.
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? "Cancel" : "+ Add delegate"}
        </button>
      </div>

      {showForm && (
        <div className="card">
          <form onSubmit={handleAdd} className="flex items-end gap-3">
            <div className="flex-1">
              <label className="label">Phone (digits only)</label>
              <input
                className="input font-mono"
                placeholder="14255245126"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </div>
            <div className="flex-1">
              <label className="label">Name</label>
              <input
                className="input"
                placeholder="Jack Be Home Remodeling"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <button
              type="submit"
              className="btn-primary"
              disabled={addDelegate.isPending}
            >
              {addDelegate.isPending ? "Adding…" : "Add"}
            </button>
          </form>
        </div>
      )}

      <div className="card p-0">
        <table className="table">
          <thead>
            <tr>
              <th className="w-16">Active</th>
              <th>Name</th>
              <th>Phone</th>
              <th>Permissions</th>
              <th className="w-24"></th>
            </tr>
          </thead>
          <tbody>
            {delegates.isLoading && (
              <tr>
                <td colSpan={5} className="py-8 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
            {delegates.data?.items.length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 text-center text-slate-500">
                  No delegates yet. Click <b>+ Add delegate</b> to authorize
                  someone.
                </td>
              </tr>
            )}
            {delegates.data?.items.map((d) => (
              <tr key={d.id}>
                <td>
                  <button
                    onClick={() =>
                      toggleDelegate.mutate({
                        phone: d.phone,
                        enabled: !d.enabled,
                      })
                    }
                    className={
                      "relative inline-flex h-6 w-11 items-center rounded-full transition-colors " +
                      (d.enabled ? "bg-brand-500" : "bg-slate-300")
                    }
                    title={d.enabled ? "Click to disable" : "Click to enable"}
                  >
                    <span
                      className={
                        "inline-block h-4 w-4 rounded-full bg-white transition-transform " +
                        (d.enabled ? "translate-x-6" : "translate-x-1")
                      }
                    />
                  </button>
                </td>
                <td className="font-medium">{d.name}</td>
                <td className="font-mono text-sm text-slate-500">{d.phone}</td>
                <td className="text-sm text-slate-500">
                  {d.allowedCommands.length > 0
                    ? d.allowedCommands.join(", ")
                    : "Read-only (status, audit, help)"}
                </td>
                <td className="text-right">
                  <button
                    onClick={() => {
                      if (confirm(`Remove ${d.name}?`)) {
                        deleteDelegate.mutate(d.phone);
                      }
                    }}
                    className="btn-danger text-xs"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 className="mb-2 text-sm font-semibold text-slate-600">
          How it works
        </h3>
        <ul className="space-y-1 text-sm text-slate-500">
          <li>
            When <b>active</b>, they DM you a command like{" "}
            <code className="font-mono">/statustoday</code> and get the reply
            in your chat with them.
          </li>
          <li>
            When <b>disabled</b>, their commands are ignored — normal messages
            still come through.
          </li>
          <li>
            By default they can only use read-only commands (status, audit,
            help). They cannot create schedules, reminders, or manage other
            delegates.
          </li>
        </ul>
      </div>
    </div>
  );
}
