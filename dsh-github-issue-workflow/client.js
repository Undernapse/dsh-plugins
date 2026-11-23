/**
 * GitHub issue workflow — the right-click menu of a GitHub issue link.
 *
 * A GitHub issue URL captured by the Web context-menu service (`kind: 'url'`,
 * from a chat link or a web tool result) offers the uworkflow commands that
 * fit an issue: `/ugo`, `/ufast`, and `/uloop`. Each command asks where to run
 * and then either opens a new Session and sends the command into it, opens a
 * new Session with the command in its composer for review, or sends the
 * command into the Session the link was clicked in.
 *
 * The bundle must stay one self-contained script: the browser module loader
 * serves it as a factory and does not resolve relative imports.
 */
window.__ModuleLoader__.load({
	id: '@undernapse/dsh-github-issue-workflow',
	factory() {
		/** Client locale namespace owned by this plugin. */
		const NS = 'github-issue-workflow'

		/** English copy; the foundation other translations follow. */
		const EN = {
			'command.ugo': 'Route this issue (/ugo)',
			'command.ufast': 'Small change (/ufast)',
			'command.uloop': 'Deliver autonomously (/uloop)',
			'target.run': 'Open a new session and run',
			'target.new': 'Open a new session (not sent)',
			'target.current': 'Send to this session now',
			'notice.started': 'Started {command} in a new session',
			'notice.sent': 'Sent {command} to this session',
			'notice.queued': 'Queued {command} behind the current turn',
			'failure.new': 'Could not start the command in a new session',
			'failure.send': 'Could not send the command to this session',
		}

		/** Chinese copy. */
		const ZH = {
			'command.ugo': '分派此议题（/ugo）',
			'command.ufast': '小改动（/ufast）',
			'command.uloop': '自主交付（/uloop）',
			'target.run': '在新会话中打开并运行',
			'target.new': '在新会话中打开（不发送）',
			'target.current': '立即发送到当前会话',
			'notice.started': '已在新会话中启动 {command}',
			'notice.sent': '已将 {command} 发送到当前会话',
			'notice.queued': '{command} 已排在当前回合之后',
			'failure.new': '无法在新会话中启动该命令',
			'failure.send': '无法把命令发送到该会话',
		}

		/** Japanese copy. */
		const JA = {
			'command.ugo': 'このイシューを振り分ける（/ugo）',
			'command.ufast': '小さな変更（/ufast）',
			'command.uloop': '自律的に届ける（/uloop）',
			'target.run': '新しいセッションで開いて実行',
			'target.new': '新しいセッションで開く（未送信）',
			'target.current': 'このセッションに今すぐ送信',
			'notice.started': '新しいセッションで {command} を開始しました',
			'notice.sent': '{command} をこのセッションに送信しました',
			'notice.queued': '{command} を現在のターンの後に追加しました',
			'failure.new': '新しいセッションでコマンドを開始できませんでした',
			'failure.send': 'このセッションにコマンドを送信できませんでした',
		}

		/** Spanish copy. */
		const ES = {
			'command.ugo': 'Encaminar esta incidencia (/ugo)',
			'command.ufast': 'Cambio pequeño (/ufast)',
			'command.uloop': 'Entregar de forma autónoma (/uloop)',
			'target.run': 'Abrir una sesión nueva y ejecutar',
			'target.new': 'Abrir una sesión nueva (sin enviar)',
			'target.current': 'Enviar a esta sesión ahora',
			'notice.started': 'Se inició {command} en una sesión nueva',
			'notice.sent': 'Se envió {command} a esta sesión',
			'notice.queued': '{command} quedó en cola tras el turno actual',
			'failure.new': 'No se pudo iniciar el comando en una sesión nueva',
			'failure.send': 'No se pudo enviar el comando a esta sesión',
		}

		/** French copy. */
		const FR = {
			'command.ugo': 'Acheminer cette issue (/ugo)',
			'command.ufast': 'Petit changement (/ufast)',
			'command.uloop': 'Livrer en autonomie (/uloop)',
			'target.run': 'Ouvrir une nouvelle session et exécuter',
			'target.new': 'Ouvrir une nouvelle session (non envoyé)',
			'target.current': 'Envoyer dans cette session maintenant',
			'notice.started': '{command} a démarré dans une nouvelle session',
			'notice.sent': '{command} a été envoyé à cette session',
			'notice.queued': '{command} est en file après le tour en cours',
			'failure.new': 'Impossible de démarrer la commande dans une nouvelle session',
			'failure.send': 'Impossible d’envoyer la commande à cette session',
		}

		/** German copy. */
		const DE = {
			'command.ugo': 'Issue weiterleiten (/ugo)',
			'command.ufast': 'Kleine Änderung (/ufast)',
			'command.uloop': 'Autonom liefern (/uloop)',
			'target.run': 'Neue Sitzung öffnen und ausführen',
			'target.new': 'Neue Sitzung öffnen (nicht gesendet)',
			'target.current': 'Jetzt an diese Sitzung senden',
			'notice.started': '{command} wurde in einer neuen Sitzung gestartet',
			'notice.sent': '{command} wurde an diese Sitzung gesendet',
			'notice.queued': '{command} wartet hinter dem laufenden Durchgang',
			'failure.new': 'Der Befehl konnte in einer neuen Sitzung nicht gestartet werden',
			'failure.send': 'Der Befehl konnte nicht an diese Sitzung gesendet werden',
		}

		/** Russian copy. */
		const RU = {
			'command.ugo': 'Направить задачу (/ugo)',
			'command.ufast': 'Небольшое изменение (/ufast)',
			'command.uloop': 'Доставить автономно (/uloop)',
			'target.run': 'Открыть новый сеанс и запустить',
			'target.new': 'Открыть новый сеанс (не отправлено)',
			'target.current': 'Отправить в этот сеанс сейчас',
			'notice.started': '{command} запущен в новом сеансе',
			'notice.sent': '{command} отправлен в этот сеанс',
			'notice.queued': '{command} в очереди после текущего хода',
			'failure.new': 'Не удалось запустить команду в новом сеансе',
			'failure.send': 'Не удалось отправить команду в этот сеанс',
		}

		/** Portuguese copy. */
		const PT = {
			'command.ugo': 'Encaminhar esta issue (/ugo)',
			'command.ufast': 'Mudança pequena (/ufast)',
			'command.uloop': 'Entregar de forma autônoma (/uloop)',
			'target.run': 'Abrir uma nova sessão e executar',
			'target.new': 'Abrir uma nova sessão (não enviado)',
			'target.current': 'Enviar para esta sessão agora',
			'notice.started': '{command} foi iniciado em uma nova sessão',
			'notice.sent': '{command} foi enviado para esta sessão',
			'notice.queued': '{command} ficou na fila após o turno atual',
			'failure.new': 'Não foi possível iniciar o comando em uma nova sessão',
			'failure.send': 'Não foi possível enviar o comando para esta sessão',
		}

		/**
		 * Commands offered for an issue, in menu order. Each entry is the
		 * slash-command a Session runs; the label starts with what the command
		 * does and ends with the command itself.
		 */
		const COMMANDS = [
			{ id: 'ugo', label: 'command.ugo' },
			{ id: 'ufast', label: 'command.ufast' },
			{ id: 'uloop', label: 'command.uloop' },
		]

		/**
		 * One GitHub issue page: `https://github.com/<owner>/<repo>/issues/<n>`,
		 * with an optional trailing path, query, or fragment. Pull requests and
		 * every other host stay out so the menu never appears where these
		 * commands do not fit.
		 */
		const ISSUE_URL = /^(?:https?:)?\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)(?:[/?#]\S*)?$/i

		/**
		 * Read one issue URL.
		 * @param {unknown} url - captured link target.
		 * @returns {{owner: string, repo: string, number: number, url: string} | undefined}
		 *   the canonical issue URL, or undefined for any other link.
		 */
		function issueFromUrl(url) {
			if (typeof url !== 'string') return undefined
			const match = ISSUE_URL.exec(url.trim())
			if (match === null) return undefined
			const [, owner, repo, number] = match
			return {
				owner,
				repo,
				number: Number(number),
				url: `https://github.com/${owner}/${repo}/issues/${number}`,
			}
		}

		/**
		 * The exact text a Session receives for one command and issue.
		 * @param {string} command - slash command without its slash.
		 * @param {{url: string}} issue - captured issue.
		 * @returns {string} the command line, with the skill token first.
		 */
		function commandLine(command, issue) {
			return `/${command} ${issue.url}`
		}

		/**
		 * The Workspace a new Session should join: the one that lists the
		 * Session whose link was clicked, else the most recently active
		 * Workspace, mirroring the New Session action. A Workspace is what the
		 * Host attaches the Session to, so a cwd alone would leave it ungrouped.
		 * @param {object} ctx - plugin context.
		 * @param {string} sessionId - Session that owns the clicked link.
		 * @returns {string | undefined} the Workspace id, or undefined before any Workspace exists.
		 */
		function preferredWorkspace(ctx, sessionId) {
			const workspaces = ctx.workspaces.list.getSnapshot()
			const sessions = ctx.sessions.list.getSnapshot()
			const owner = workspaces.items.find(item => item.sessionIds.includes(sessionId))
			if (owner !== undefined) return owner.workspaceId
			let selected
			let selectedTime = Number.NEGATIVE_INFINITY
			for (const workspace of workspaces.items) {
				let latest = Number.NEGATIVE_INFINITY
				for (const id of workspace.sessionIds) {
					const session = sessions.byId[id]
					if (session !== undefined) latest = Math.max(latest, session.updatedAt)
				}
				if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
				if (selected === undefined || latest > selectedTime) {
					selected = workspace.workspaceId
					selectedTime = latest
				}
			}
			return selected
		}

		/**
		 * Deliver one command line to a Session, through the Client scope when
		 * its Conversation is live and through the Session binding otherwise.
		 * @param {object} ctx - plugin context.
		 * @param {string} sessionId - Session to receive the command.
		 * @param {string} text - command line.
		 * @returns {Promise<boolean>} whether the Session was already mid-turn.
		 */
		async function deliver(ctx, sessionId, text) {
			const binding = ctx.sessions.binding(sessionId)
			const queued = binding?.session.getSnapshot().running === true
			const scoped = ctx.sessions.scope(sessionId)
			if (scoped !== undefined) {
				await scoped.conversation.send(text)
			} else if (binding !== undefined) {
				const result = await binding.session.prompt([{ type: 'text', text }], 'queue')
				if (!result.ok) throw new Error('github-issue-workflow: the prompt was rejected')
			} else {
				throw new Error('github-issue-workflow: the session cannot receive a message')
			}
			return queued
		}

		/**
		 * Open a new Session in the current or most recent Workspace with the
		 * command typed in its composer, so the user reviews it before sending.
		 * `startSession` reports its own failures through the Workspace notice
		 * and may append to an unsent draft, so neither is duplicated here.
		 * @param {object} ctx - plugin context.
		 * @param {string} command - slash command without its slash.
		 * @param {{url: string}} issue - captured issue.
		 */
		function openDraftSession(ctx, command, issue) {
			ctx.uiWorkspace.startSession(undefined, {
				prompt: commandLine(command, issue),
				whenDraftExists: 'append',
			})
		}

		/**
		 * Open a new Session in the Workspace that holds the clicked Session
		 * and send the command into it, so the workflow starts without another
		 * click. Falls back to the unsent draft when no Workspace exists yet,
		 * because the Host needs one to attach the Session and the default
		 * Workspace is created only by the New Session flow.
		 * @param {object} ctx - plugin context.
		 * @param {string} sessionId - Session that owns the clicked link.
		 * @param {string} command - slash command without its slash.
		 * @param {{url: string}} issue - captured issue.
		 * @param {(key: string, params?: object) => string} t - localized copy.
		 * @returns {Promise<void>} completion after the Host accepts the prompt.
		 */
		async function runInNewSession(ctx, sessionId, command, issue, t) {
			const workspaceId = preferredWorkspace(ctx, sessionId)
			if (workspaceId === undefined) {
				openDraftSession(ctx, command, issue)
				return
			}
			const target = await ctx.uiWorkspace.connectWorkspace(workspaceId)
			ctx.uiWorkspace.openSession(target)
			await deliver(ctx, target, commandLine(command, issue))
			ctx.contextMenus.notify(t('notice.started', { command: `/${command}` }), true)
		}

		/**
		 * Send the command into the Session the link was clicked in. The
		 * conversation service supplies the composer's own submission path
		 * (echo, queue, prompt error); the session binding is the fallback when
		 * that Session has no live Client scope.
		 * @param {object} ctx - plugin context.
		 * @param {string} sessionId - Session that owns the clicked link.
		 * @param {string} command - slash command without its slash.
		 * @param {{url: string}} issue - captured issue.
		 * @param {(key: string, params?: object) => string} t - localized copy.
		 * @returns {Promise<void>} completion after the Host accepts the prompt.
		 */
		async function sendToSession(ctx, sessionId, command, issue, t) {
			const queued = await deliver(ctx, sessionId, commandLine(command, issue))
			ctx.contextMenus.notify(t(queued ? 'notice.queued' : 'notice.sent', { command: `/${command}` }), true)
		}

		/**
		 * Whether one Session currently has a Client scope or binding to send
		 * through, so the menu can offer only destinations that work.
		 * @param {object} ctx - plugin context.
		 * @param {string} sessionId - Session that owns the clicked link.
		 * @returns {boolean} whether the current-session destination applies.
		 */
		function canReceive(ctx, sessionId) {
			return ctx.sessions.scope(sessionId) !== undefined || ctx.sessions.binding(sessionId) !== undefined
		}

		return {
			/** Services the menu contributions require. */
			inject: ['contextMenus', 'sessions', 'uiWorkspace', 'workspaces', 'locale'],
			/**
			 * Register the issue-link menu.
			 * @param {object} ctx - plugin context.
			 */
			apply(ctx) {
				ctx.effect(
					() => ctx.locale.register(NS, { en: EN, zh: ZH, ja: JA, es: ES, fr: FR, de: DE, ru: RU, pt: PT }),
					'github issue workflow: locale',
				)
				const t = ctx.locale.bind(NS)

				ctx.effect(() => ctx.contextMenus.register({
					id: 'github-issue-workflow.issue',
					target: 'url',
					order: 300,
					observe: () => [ctx.locale],
					resolve: (target) => {
						const issue = issueFromUrl(target.url)
						if (issue === undefined) return []
						const destinations = canReceive(ctx, target.sessionId)
						return COMMANDS.map((command, index) => ({
							id: command.id,
							label: t(command.label),
							separatorBefore: index === 0,
							children: [
								{
									id: `${command.id}:run`,
									label: t('target.run'),
									failureLabel: t('failure.new'),
									run: () => runInNewSession(ctx, target.sessionId, command.id, issue, t),
								},
								{
									id: `${command.id}:new`,
									label: t('target.new'),
									run: () => openDraftSession(ctx, command.id, issue),
								},
								...destinations ? [{
									id: `${command.id}:current`,
									label: t('target.current'),
									failureLabel: t('failure.send'),
									run: () => sendToSession(ctx, target.sessionId, command.id, issue, t),
								}] : [],
							],
						}))
					},
				}), 'github issue workflow: issue link menu')
			},
		}
	},
})
