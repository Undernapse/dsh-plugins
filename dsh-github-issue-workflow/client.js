/**
 * GitHub issue workflow — the right-click menu of a GitHub issue link.
 *
 * A GitHub issue URL captured by the Web context-menu service (`kind: 'url'`,
 * from a chat link or a web tool result) offers the uworkflow commands that
 * fit an issue: `/ugo`, `/ufast`, and `/uloop`. Each command asks where to run
 * and then either opens a new Session with the command in its composer or
 * sends the command into the Session the link was clicked in.
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
			'target.new': 'Open a new session (not sent)',
			'target.current': 'Send to this session now',
			'notice.sent': 'Sent {command} to this session',
			'notice.queued': 'Queued {command} behind the current turn',
			'failure.send': 'Could not send the command to this session',
		}

		/** Chinese copy. */
		const ZH = {
			'command.ugo': '分派此议题（/ugo）',
			'command.ufast': '小改动（/ufast）',
			'command.uloop': '自主交付（/uloop）',
			'target.new': '在新会话中打开（不发送）',
			'target.current': '立即发送到当前会话',
			'notice.sent': '已将 {command} 发送到当前会话',
			'notice.queued': '{command} 已排在当前回合之后',
			'failure.send': '无法把命令发送到该会话',
		}

		/** Japanese copy. */
		const JA = {
			'command.ugo': 'このイシューを振り分ける（/ugo）',
			'command.ufast': '小さな変更（/ufast）',
			'command.uloop': '自律的に届ける（/uloop）',
			'target.new': '新しいセッションで開く（未送信）',
			'target.current': 'このセッションに今すぐ送信',
			'notice.sent': '{command} をこのセッションに送信しました',
			'notice.queued': '{command} を現在のターンの後に追加しました',
			'failure.send': 'このセッションにコマンドを送信できませんでした',
		}

		/** Spanish copy. */
		const ES = {
			'command.ugo': 'Encaminar esta incidencia (/ugo)',
			'command.ufast': 'Cambio pequeño (/ufast)',
			'command.uloop': 'Entregar de forma autónoma (/uloop)',
			'target.new': 'Abrir una sesión nueva (sin enviar)',
			'target.current': 'Enviar a esta sesión ahora',
			'notice.sent': 'Se envió {command} a esta sesión',
			'notice.queued': '{command} quedó en cola tras el turno actual',
			'failure.send': 'No se pudo enviar el comando a esta sesión',
		}

		/** French copy. */
		const FR = {
			'command.ugo': 'Acheminer cette issue (/ugo)',
			'command.ufast': 'Petit changement (/ufast)',
			'command.uloop': 'Livrer en autonomie (/uloop)',
			'target.new': 'Ouvrir une nouvelle session (non envoyé)',
			'target.current': 'Envoyer dans cette session maintenant',
			'notice.sent': '{command} a été envoyé à cette session',
			'notice.queued': '{command} est en file après le tour en cours',
			'failure.send': 'Impossible d’envoyer la commande à cette session',
		}

		/** German copy. */
		const DE = {
			'command.ugo': 'Issue weiterleiten (/ugo)',
			'command.ufast': 'Kleine Änderung (/ufast)',
			'command.uloop': 'Autonom liefern (/uloop)',
			'target.new': 'Neue Sitzung öffnen (nicht gesendet)',
			'target.current': 'Jetzt an diese Sitzung senden',
			'notice.sent': '{command} wurde an diese Sitzung gesendet',
			'notice.queued': '{command} wartet hinter dem laufenden Durchgang',
			'failure.send': 'Der Befehl konnte nicht an diese Sitzung gesendet werden',
		}

		/** Russian copy. */
		const RU = {
			'command.ugo': 'Направить задачу (/ugo)',
			'command.ufast': 'Небольшое изменение (/ufast)',
			'command.uloop': 'Доставить автономно (/uloop)',
			'target.new': 'Открыть новый сеанс (не отправлено)',
			'target.current': 'Отправить в этот сеанс сейчас',
			'notice.sent': '{command} отправлен в этот сеанс',
			'notice.queued': '{command} в очереди после текущего хода',
			'failure.send': 'Не удалось отправить команду в этот сеанс',
		}

		/** Portuguese copy. */
		const PT = {
			'command.ugo': 'Encaminhar esta issue (/ugo)',
			'command.ufast': 'Mudança pequena (/ufast)',
			'command.uloop': 'Entregar de forma autônoma (/uloop)',
			'target.new': 'Abrir uma nova sessão (não enviado)',
			'target.current': 'Enviar para esta sessão agora',
			'notice.sent': '{command} foi enviado para esta sessão',
			'notice.queued': '{command} ficou na fila após o turno atual',
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
		 * Open a new Session in the current or most recent Workspace with the
		 * command typed in its composer, so the user reviews it before sending.
		 * `startSession` reports its own failures through the Workspace notice
		 * and may append to an unsent draft, so neither is duplicated here.
		 * @param {object} ctx - plugin context.
		 * @param {string} command - slash command without its slash.
		 * @param {{url: string}} issue - captured issue.
		 */
		function openNewSession(ctx, command, issue) {
			ctx.uiWorkspace.startSession(undefined, {
				prompt: commandLine(command, issue),
				whenDraftExists: 'append',
			})
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
			const text = commandLine(command, issue)
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
			inject: ['contextMenus', 'sessions', 'uiWorkspace', 'locale'],
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
									id: `${command.id}:new`,
									label: t('target.new'),
									run: () => openNewSession(ctx, command.id, issue),
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
