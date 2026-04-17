import { useState } from "react";
import { useChatList, useExcludeMessage, useMessages } from "../api/hooks";

export function Messages() {
  const [search, setSearch] = useState("");
  const [chatName, setChatName] = useState("");
  const [isGroup, setIsGroup] = useState<"true" | "false" | "">("");

  const messages = useMessages({ search, chatName, isGroup });
  const chats = useChatList();
  const excludeMessage = useExcludeMessage();

  const handleExclude = async (id: string, preview: string) => {
    const short = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;
    if (
      !window.confirm(
        `Exclude this message from lead counts?\n\n"${short}"\n\nThe row is kept, but /statustoday etc will ignore it.`,
      )
    ) {
      return;
    }
    try {
      await excludeMessage.mutateAsync(id);
    } catch (err) {
      window.alert(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Mensagens</h2>
        <p className="text-sm text-slate-500">
          Navegue por todas as mensagens salvas do WhatsApp.
        </p>
      </div>

      <div className="card">
        <div className="grid gap-4 md:grid-cols-4">
          <div>
            <label className="label">Buscar</label>
            <input
              className="input"
              placeholder="texto ou nome"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Chat / Grupo</label>
            <input
              className="input"
              placeholder="nome do grupo"
              value={chatName}
              onChange={(e) => setChatName(e.target.value)}
              list="chat-names"
            />
            <datalist id="chat-names">
              {chats.data?.chats.map((c) => (
                <option key={c.chatId} value={c.chatName ?? c.chatId} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="label">Tipo</label>
            <select
              className="input"
              value={isGroup}
              onChange={(e) => setIsGroup(e.target.value as "" | "true" | "false")}
            >
              <option value="">Todos</option>
              <option value="true">Grupos</option>
              <option value="false">Individuais</option>
            </select>
          </div>
          <div className="flex items-end">
            <button
              className="btn-secondary w-full"
              onClick={() => {
                setSearch("");
                setChatName("");
                setIsGroup("");
              }}
            >
              Limpar
            </button>
          </div>
        </div>
      </div>

      <div className="card p-0">
        <div className="max-h-[70vh] overflow-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Chat</th>
                <th>Remetente</th>
                <th>Conteúdo</th>
                <th className="w-24"></th>
              </tr>
            </thead>
            <tbody>
              {messages.isLoading && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    Carregando…
                  </td>
                </tr>
              )}
              {messages.data?.items.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    Nenhuma mensagem.
                  </td>
                </tr>
              )}
              {messages.data?.items.map((m) => {
                const isExcluded = m.content === "[excluded]" || m.content === "[deleted]";
                return (
                  <tr key={m.id} className={isExcluded ? "opacity-50" : undefined}>
                    <td className="whitespace-nowrap text-xs text-slate-500">
                      {new Date(m.timestamp).toLocaleString()}
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        {m.isGroup && (
                          <span className="badge bg-sky-50 text-sky-700">grupo</span>
                        )}
                        <span className="font-medium">
                          {m.chatName ?? m.chatId}
                        </span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-slate-600">
                      {m.isFromMe ? (
                        <span className="italic text-slate-400">(eu)</span>
                      ) : (
                        m.senderName ?? m.senderPhone ?? "—"
                      )}
                    </td>
                    <td className="max-w-xl">
                      <div className="line-clamp-3 whitespace-pre-wrap text-slate-800">
                        {m.content}
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {!isExcluded && (
                        <button
                          onClick={() => handleExclude(m.id, m.content)}
                          disabled={excludeMessage.isPending}
                          className="btn-secondary text-xs"
                          title="Remove this message from lead counts"
                        >
                          Excluir
                        </button>
                      )}
                      {isExcluded && (
                        <span className="text-xs italic text-slate-400">
                          excluída
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
