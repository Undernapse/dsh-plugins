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

		/** English copy; every other locale falls back to it. */
		const EN = {
			'command.ugo': '/ugo — route this issue',
			'command.ufast': '/ufast — small change',
			'command.uloop': '/uloop — autonomous loop',
			'target.new': 'In a new session',
			'target.current': 'In this session',
			'notice.new': 'New session opened with {command} in its composer',
			'notice.sent': 'Sent {command} to this session',
			'failure.new': 'Could not open a new session',
			'failure.send': 'Could not send the command to this session',
			'failure.unavailable': 'This session can no longer receive a message',
		}

		/** Chinese copy. */
		const ZH = {
			'command.ugo': '/ugo — 分派此议题',
			'command.ufast': '/ufast — 小改动',
			'command.uloop': '/uloop — 自主交付循环',
			'target.new': '在新会话中',
			'target.current': '在当前会话中',
			'notice.new': '已新建会话，命令 {command} 已填入输入框',
			'notice.sent': '已将 {command} 发送到当前会话',
			'failure.new': '无法新建会话',
			'failure.send': '无法把命令发送到该会话',
			'failure.unavailable': '该会话已无法接收消息',
		}

		/**
		 * Commands offered for an issue, in menu order. Each entry is the
		 * slash-command a Session runs; the label says what the skill does.
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
		 * Open a new Session in the current Workspace with the command typed in
		 * its composer, so the user reviews it before sending.
		 * @param {object} ctx - plugin context.
		 * @param {string} command - slash command without its slash.
		 * @param {{url: string}} issue - captured issue.
		 * @param {(key: string, params?: object) => string} t - localized copy.
		 */
		function openNewSession(ctx, command, issue, t) {
			ctx.uiWorkspace.startSession(undefined, {
				prompt: commandLine(command, issue),
				whenDraftExists: 'replace',
			})
			ctx.contextMenus.notify(t('notice.new', { command: `/${command}` }), true)
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
			const scoped = ctx.sessions.scope(sessionId)
			if (scoped !== undefined) {
				await scoped.conversation.send(text)
			} else {
				const binding = ctx.sessions.binding(sessionId)
				if (binding === undefined) throw new Error(t('failure.unavailable'))
				const result = await binding.session.prompt([{ type: 'text', text }], 'queue')
				if (!result.ok) throw new Error(t('failure.send'))
			}
			ctx.contextMenus.notify(t('notice.sent', { command: `/${command}` }), true)
		}

		return {
			/** Services the menu contributions require. */
			inject: ['contextMenus', 'sessions', 'uiWorkspace', 'conversation', 'locale'],
			/**
			 * Register the issue-link menu.
			 * @param {object} ctx - plugin context.
			 */
			apply(ctx) {
				ctx.effect(
					() => ctx.locale.register(NS, { en: EN, zh: ZH }),
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
						return COMMANDS.map((command, index) => ({
							id: command.id,
							label: t(command.label),
							separatorBefore: index === 0,
							children: [
								{
									id: `${command.id}:new`,
									label: t('target.new'),
									failureLabel: t('failure.new'),
									run: () => openNewSession(ctx, command.id, issue, t),
								},
								{
									id: `${command.id}:current`,
									label: t('target.current'),
									failureLabel: t('failure.send'),
									run: () => sendToSession(ctx, target.sessionId, command.id, issue, t),
								},
							],
						}))
					},
				}), 'github issue workflow: issue link menu')
			},
		}
	},
})
