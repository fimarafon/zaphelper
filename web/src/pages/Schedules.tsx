import { useState } from "react";
import {
  useCreateSchedule,
  useDeleteSchedule,
  useRunScheduleNow,
  useScheduleActions,
  useSchedules,
  useToggleSchedule,
  type ScheduledTask,
} from "../api/hooks";

type ScheduleKind = "cron" | "once";

interface FormState {
  name: string;
  kind: ScheduleKind;
  cronExpression: string;
  fireAt: string;
  actionType: string;
  actionPayloadJson: string;
}

const DEFAULT_FORM: FormState = {
  name: "",
  kind: "cron",
  cronExpression: "0 9 * * 1",
  fireAt: "",
  actionType: "runCommand",
  actionPayloadJson: JSON.stringify(
    { command: "/statusweek", deliverToSelf: true },
    null,
    2,
  ),
};

export function Schedules() {
  const schedules = useSchedules();
  const actions = useScheduleActions();
  const createTask = useCreateSchedule();
  const toggleTask = useToggleSchedule();
  const runNow = useRunScheduleNow();
  const deleteTask = useDeleteSchedule();

  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      const actionPayload = JSON.parse(form.actionPayloadJson);
      const body: {
        name: string;
        actionType: string;
        actionPayload: Record<string, unknown>;
        cronExpression?: string;
        fireAt?: string;
      } = {
        name: form.name,
        actionType: form.actionType,
        actionPayload,
      };
      if (form.kind === "cron") {
        body.cronExpression = form.cronExpression;
      } else {
        body.fireAt = new Date(form.fireAt).toISOString();
      }
      await createTask.mutateAsync(body);
      setForm(DEFAULT_FORM);
      setShowForm(false);
    } catch (err) {
      setFormError((err as Error).message);
    }
  };

  const handleActionTypeChange = (type: string) => {
    setForm((f) => ({
      ...f,
      actionType: type,
      actionPayloadJson: JSON.stringify(payloadTemplateFor(type), null, 2),
    }));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Schedules</h2>
          <p className="text-sm text-slate-500">
            Automated tasks that fire on a cron schedule or once at a specific time.
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? "Cancel" : "+ New schedule"}
        </button>
      </div>

      {showForm && (
        <div className="card">
          <h3 className="mb-4 text-sm font-semibold text-slate-600">
            Create scheduled task
          </h3>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Name</label>
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Weekly lead report"
                required
              />
            </div>

            <div>
              <label className="label">Schedule type</label>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={form.kind === "cron"}
                    onChange={() => setForm({ ...form, kind: "cron" })}
                  />
                  Recurring (cron)
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={form.kind === "once"}
                    onChange={() => setForm({ ...form, kind: "once" })}
                  />
                  One-shot
                </label>
              </div>
            </div>

            {form.kind === "cron" ? (
              <div>
                <label className="label">Cron expression</label>
                <input
                  className="input font-mono"
                  value={form.cronExpression}
                  onChange={(e) =>
                    setForm({ ...form, cronExpression: e.target.value })
                  }
                  placeholder="0 9 * * 1"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Standard 5-field cron. Examples:{" "}
                  <code className="font-mono">0 9 * * *</code> daily 9am,{" "}
                  <code className="font-mono">0 9 * * 1</code> Mon 9am,{" "}
                  <code className="font-mono">0 18 * * 1-5</code> weekdays 6pm.
                </p>
              </div>
            ) : (
              <div>
                <label className="label">Fire at</label>
                <input
                  type="datetime-local"
                  className="input"
                  value={form.fireAt}
                  onChange={(e) => setForm({ ...form, fireAt: e.target.value })}
                  required
                />
              </div>
            )}

            <div>
              <label className="label">Action type</label>
              <select
                className="input"
                value={form.actionType}
                onChange={(e) => handleActionTypeChange(e.target.value)}
              >
                {actions.data?.actions.map((a) => (
                  <option key={a.type} value={a.type}>
                    {a.type} — {a.description}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Payload (JSON)</label>
              <textarea
                className="input font-mono text-xs"
                rows={8}
                value={form.actionPayloadJson}
                onChange={(e) =>
                  setForm({ ...form, actionPayloadJson: e.target.value })
                }
              />
              <PayloadHelp actionType={form.actionType} />
            </div>

            {formError && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
                {formError}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="submit"
                className="btn-primary"
                disabled={createTask.isPending}
              >
                {createTask.isPending ? "Creating…" : "Create task"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setForm(DEFAULT_FORM);
                  setShowForm(false);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Tasks list */}
      <div className="card p-0">
        <table className="table">
          <thead>
            <tr>
              <th className="w-12">On</th>
              <th>Name</th>
              <th>Schedule</th>
              <th>Action</th>
              <th>Last run</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {schedules.isLoading && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
            {schedules.data?.items.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-slate-500">
                  No scheduled tasks yet. Click <b>+ New schedule</b> to create one.
                </td>
              </tr>
            )}
            {schedules.data?.items.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onToggle={(enabled) =>
                  toggleTask.mutate({ id: task.id, enabled })
                }
                onRun={() => runNow.mutate(task.id)}
                onDelete={() => {
                  if (confirm(`Delete task "${task.name}"?`)) {
                    deleteTask.mutate(task.id);
                  }
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  onToggle,
  onRun,
  onDelete,
}: {
  task: ScheduledTask;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
  onDelete: () => void;
}) {
  return (
    <tr>
      <td>
        <input
          type="checkbox"
          checked={task.enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
      </td>
      <td>
        <div className="font-medium">{task.name}</div>
        {task.lastError && (
          <div className="mt-1 text-xs text-red-600">⚠️ {task.lastError}</div>
        )}
      </td>
      <td>
        {task.cronExpression ? (
          <code className="font-mono text-xs">{task.cronExpression}</code>
        ) : task.fireAt ? (
          <span className="text-xs text-slate-500">
            once @ {new Date(task.fireAt).toLocaleString()}
          </span>
        ) : (
          <span className="text-xs text-slate-400">manual only</span>
        )}
      </td>
      <td>
        <span className="badge bg-sky-50 text-sky-700">{task.actionType}</span>
      </td>
      <td className="whitespace-nowrap text-xs text-slate-500">
        {task.lastFiredAt ? (
          <>
            {new Date(task.lastFiredAt).toLocaleString()}
            <br />
            <span className="text-slate-400">
              ({task.runCount} runs, {task.failureCount} failed)
            </span>
          </>
        ) : (
          "never"
        )}
      </td>
      <td className="text-right">
        <div className="flex justify-end gap-1">
          <button className="btn-secondary text-xs" onClick={onRun} title="Run now">
            ▶ Run
          </button>
          <button className="btn-danger text-xs" onClick={onDelete}>
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

function payloadTemplateFor(actionType: string): Record<string, unknown> {
  switch (actionType) {
    case "sendText":
      return { to: "self", text: "Hello from zaphelper!" };
    case "runCommand":
      return { command: "/statusweek", deliverToSelf: true };
    case "webhook":
      return {
        url: "https://example.com/webhook",
        method: "POST",
        body: { hello: "world" },
        deliverResponse: false,
      };
    case "sendVoice":
      return {
        to: "self",
        text: "Good morning, this is a test voice message.",
        voiceId: "21m00Tcm4TlvDq8ikWAM",
      };
    default:
      return {};
  }
}

function PayloadHelp({ actionType }: { actionType: string }) {
  const help: Record<string, string> = {
    sendText: '{"to": "self" | "15551234567", "text": "your message"}',
    runCommand:
      '{"command": "/statusweek", "deliverToSelf": true} — runs an internal command and sends the reply to your self-chat',
    webhook:
      '{"url": "https://...", "method": "POST", "body": {...}, "headers": {...}, "deliverResponse": false}',
    sendVoice:
      '{"to": "self", "text": "...", "voiceId": "21m00Tcm4TlvDq8ikWAM"} — requires ELEVENLABS_API_KEY env var',
  };
  return (
    <p className="mt-1 text-xs text-slate-500">
      <code className="font-mono">{help[actionType] ?? ""}</code>
    </p>
  );
}
