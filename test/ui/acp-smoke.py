"""Exercise packaged ACP conversation controls with real stdio agents and task workspaces."""
import json
import os
from pathlib import Path
import subprocess
from time import monotonic
from playwright.sync_api import sync_playwright, expect

artifacts = Path(os.environ.get('WARDEN_UI_ARTIFACTS', '/tmp/warden-ui-artifacts'))
artifacts.mkdir(parents=True, exist_ok=True)
host = subprocess.Popen(['node', '--import', 'tsx', 'test/ui/acp-harness.ts'], stdout=subprocess.PIPE, text=True)
try:
    info = json.loads(host.stdout.readline())
    origin = f"http://127.0.0.1:{info['port']}"
    with sync_playwright() as playwright:
        executable = os.environ.get('CHROMIUM_PATH') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
        browser = playwright.chromium.launch(executable_path=executable, headless=True, args=['--no-sandbox'])
        first = browser.new_page(viewport={'width': 1000, 'height': 900})
        second = browser.new_page(viewport={'width': 1000, 'height': 900})
        errors = []
        for page in [first, second]:
            page.on('pageerror', lambda error: errors.append(str(error)))

        def inspect():
            return first.request.get(origin + '/inspect').json()

        def send(page, text):
            page.get_by_role('textbox', name='消息', exact=True).fill(text)
            page.get_by_role('button', name='发送', exact=True).click()

        def connected(page):
            page.wait_for_function("window.__model.status === 'connected' && !window.__model.sending")

        def wait_host(page, route, predicate):
            # Poll resolved host state: wait_for_function treats an async predicate's
            # Promise as truthy before its eventual boolean result is available.
            task = page.evaluate("new URL(location.href).searchParams.get('task') || '0'")
            deadline = monotonic() + 30
            while monotonic() < deadline:
                state = page.request.get(origin + route + '?task=' + task).json()
                if predicate(state):
                    return state
                page.wait_for_timeout(25)
            raise AssertionError({'route': route, 'lastState': state})

        def saved_draft(page, text):
            wait_host(page, '/model', lambda model: model['draft'] == text)

        def conversation(messages):
            # Agents may replay adjacent same-role messages with different chunk boundaries.
            merged = []
            for item in messages:
                if item['role'] not in ['user', 'agent']:
                    continue
                if merged and merged[-1][0] == item['role']:
                    merged[-1][1] += item['text']
                else:
                    merged.append([item['role'], item['text']])
            return merged

        first.goto(origin + '?task=0')
        second.goto(origin + '?task=1')
        expect(first.get_by_role('heading', name='订单筛选参数', exact=True)).to_be_visible()
        expect(second.get_by_role('heading', name='分页默认值', exact=True)).to_be_visible()
        review = first.get_by_role('button', name='查看任务差异', exact=True)
        review.focus()
        expect(first.get_by_role('tooltip', name='查看任务差异', exact=True)).to_be_visible()
        review.press('Escape')
        review.click()
        first.wait_for_function("window.__actions.some(message => message.action?.type === 'review')")
        assert all(not journal for entry in inspect()['entries'] for journal in entry['journals'])

        first.evaluate("async () => { await window.__fixture.pauseModels(); window.__fixture.deliver({ ...window.__model, profiles: [] }); }")
        expect(first.get_by_role('button', name='连接 Agent', exact=True)).to_be_disabled()
        setup_guide = first.locator('.acp-setup')
        expect(setup_guide.locator('pre')).not_to_be_visible()
        setup_guide.get_by_text('ACP 配置说明与示例', exact=True).click()
        expect(setup_guide.locator('pre')).to_contain_text('warden.acpAgents')
        first.get_by_role('button', name='配置 Agent', exact=True).click()
        first.wait_for_function("window.__actions.some(message => message.action?.type === 'configure')")
        assert all(not journal for entry in inspect()['entries'] for journal in entry['journals'])
        first.screenshot(path=str(artifacts / 'acp-setup.png'), full_page=True)
        setup_guide.get_by_text('ACP 配置说明与示例', exact=True).click()
        first.evaluate("() => window.__fixture.resumeModels()")

        send(first, 'own-edit')
        expect(first.locator('.acp-message-agent')).to_contain_text('Edited')
        connected(first)
        expect(first.get_by_role('textbox', name='消息', exact=True)).to_have_value('')
        state = inspect()
        assert state['entries'][0]['output'].startswith('task 1 edited by ')
        assert state['entries'][1]['output'] is None
        assert state['primaryStatus'] == ''
        assert state['primaryContext'] == state['previewContext'] == 'primary baseline\n'

        composer = first.get_by_role('textbox', name='消息', exact=True)
        # Completion is not available for another send until its final storage
        # save and host draft bookkeeping finish, including after panel reload.
        assert first.request.post(origin + '/completion?task=0').ok
        send(first, 'held completion')
        wait_host(first, '/completion', lambda state: state['blocked'])
        first.wait_for_function("window.__model.sending && window.__model.status === 'running'")
        expect(first.locator('.acp-composer button[type="submit"]')).to_be_disabled()
        first.reload()
        first.wait_for_function("window.__model.sending && window.__model.status === 'running'")
        expect(composer).to_have_value('held completion')
        expect(first.locator('.acp-composer button[type="submit"]')).to_be_disabled()
        composer.fill('follow-up during completion')
        saved_draft(first, 'follow-up during completion')
        expect(first.locator('.acp-composer button[type="submit"]')).to_be_disabled()
        assert first.request.get(origin + '/completion?task=0').json()['blocked']
        assert first.request.delete(origin + '/completion?task=0').ok
        connected(first)
        expect(composer).to_have_value('follow-up during completion')
        expect(first.get_by_role('button', name='发送', exact=True)).to_be_enabled()
        first.get_by_role('button', name='发送', exact=True).click()
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_have_text('Echo: follow-up during completion')
        connected(first)
        expect(composer).to_have_value('')
        completion_state = inspect()['entries'][0]
        assert not completion_state['model'].get('error'), completion_state['model']
        completion_prompts = [json.loads(line) for line in completion_state['journals'][0].splitlines() if json.loads(line).get('method') == 'session/prompt']
        assert sum(any(part.get('text') == 'follow-up during completion' for part in item['params']['prompt']) for item in completion_prompts) == 1

        # Deliver two explicit sends from the same panel version while suppressing
        # model acknowledgements. Only completion clears separate their revisions.
        first.evaluate('window.__fixture.pauseModels()')
        before_clear = first.request.get(origin + '/model?task=0').json()
        for offset, text in enumerate(['unacknowledged completion', 'rapid next draft'], start=1):
            response = first.request.post(origin + '/action?task=0', data={
                'panelId': before_clear['panelId'],
                'action': {'type': 'send', 'text': text, 'profileId': 'normal',
                           'version': before_clear['draftVersion'], 'revision': before_clear['draftRevision'] + offset},
            })
            assert response.ok
            def completed_prompt(model):
                assert not model.get('error'), model
                return not model['sending'] and model['status'] == 'connected' and any(
                    item['role'] == 'user' and item['text'] == text and item.get('uncertain') is False
                    for item in model['record']['messages']
                )
            wait_host(first, '/model', completed_prompt)
        stale_clear_state = first.request.get(origin + '/model?task=0').json()
        assert stale_clear_state['draftVersion'] == before_clear['draftVersion'] + 2
        assert len([item for item in stale_clear_state['record']['messages'] if item['role'] == 'user' and item['text'] == 'rapid next draft']) == 1
        first.evaluate('window.__fixture.resumeModels()')
        expect(composer).to_have_value('')

        # Saving a draft need not echo it before the host appends an editor selection.
        # Batch the reveal and append models, as VS Code can do before React renders.
        first.evaluate('window.__fixture.pauseModels()')
        composer.fill('审查这段实现')
        saved_draft(first, '审查这段实现')
        first.evaluate("window.__fixture.append('选区内容：const page = 1;')")
        combined = '审查这段实现\n\n选区内容：const page = 1;'
        expect(composer).to_have_value(combined)
        first.evaluate('window.__fixture.resumeModels()')
        saved_draft(first, combined)
        first.get_by_role('button', name='发送', exact=True).click()
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_have_text('Echo: ' + combined)
        expect(composer).to_have_value('')

        # Hold an already posted edit across the host append. Its late arrival must
        # neither remove the excerpt nor replace the user's more recent wording.
        first.evaluate('window.__fixture.pauseModels()')
        first.evaluate('window.__fixture.holdDrafts()')
        old_model = first.evaluate('window.__model')
        composer.fill('仍在输入的补充说明')
        first.wait_for_function("window.__actions.at(-1)?.action?.type === 'draft' && window.__actions.at(-1).action.text === '仍在输入的补充说明'")
        assert inspect()['entries'][0]['model']['draft'] == ''
        first.evaluate("window.__fixture.append('选区内容：const limit = 20;')")
        pending_combined = '仍在输入的补充说明\n\n选区内容：const limit = 20;'
        expect(composer).to_have_value(pending_combined)
        first.evaluate('window.__fixture.releaseDrafts()')
        saved_draft(first, pending_combined)
        first.evaluate('model => window.__fixture.deliver(model)', old_model)
        expect(composer).to_have_value(pending_combined)
        first.evaluate('window.__fixture.resumeModels()')
        expect(composer).to_have_value(pending_combined)
        first.get_by_role('button', name='发送', exact=True).click()
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_have_text('Echo: ' + pending_combined)
        expect(composer).to_have_value('')

        # A click from a model older than an append must not silently omit context.
        composer.fill('发送前的说明')
        first.wait_for_function("window.__model.draft === '发送前的说明'")
        first.evaluate('window.__fixture.pauseModels()')
        users_before = len([item for item in inspect()['entries'][0]['model']['record']['messages'] if item['role'] == 'user'])
        first.evaluate("window.__fixture.append('选区内容：const offset = 0;', false)")
        first.get_by_role('button', name='发送', exact=True).click()
        wait_host(first, '/model', lambda model: model.get('error'))
        first.evaluate('window.__fixture.resumeModels()')
        stale_combined = '发送前的说明\n\n选区内容：const offset = 0;'
        expect(composer).to_have_value(stale_combined)
        users_after = len([item for item in inspect()['entries'][0]['model']['record']['messages'] if item['role'] == 'user'])
        assert users_after == users_before, 'a stale send must not reach the agent without the appended selection'
        first.get_by_role('button', name='发送', exact=True).click()
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_have_text('Echo: ' + stale_combined)
        expect(composer).to_have_value('')

        # A new transcript may arrive while its unchanged composer has newer local
        # edits. Hold both the model and outgoing edit to make the overlap explicit.
        previous_record = first.evaluate('window.__model.record.id')
        first.evaluate('window.__fixture.pauseModels()')
        first.evaluate('window.__fixture.holdDrafts()')
        first.get_by_role('button', name='新建会话', exact=True).click()
        wait_host(first, '/model', lambda model: model['record']['id'] != previous_record)
        composer.fill('新会话建立时输入的说明')
        newer_record = first.request.get(origin + '/model?task=0').json()
        first.evaluate('model => window.__fixture.deliver(model)', newer_record)
        expect(composer).to_have_value('新会话建立时输入的说明')
        first.evaluate('window.__fixture.releaseDrafts()')
        first.evaluate('window.__fixture.resumeModels()')
        saved_draft(first, '新会话建立时输入的说明')
        first.get_by_role('button', name='发送', exact=True).click()
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_have_text('Echo: 新会话建立时输入的说明')
        expect(composer).to_have_value('')

        send(first, 'hold')
        expect(first.get_by_role('button', name='停止本轮', exact=True)).to_be_enabled()
        first.get_by_role('textbox', name='消息', exact=True).fill('稍后继续补充分页参数')
        first.wait_for_function("window.__model.draft === '稍后继续补充分页参数'")
        send(second, 'second task')
        expect(second.locator('.acp-message-agent')).to_contain_text('Echo: second task')
        first.get_by_role('button', name='停止本轮', exact=True).click()
        connected(first)
        expect(first.get_by_role('textbox', name='消息', exact=True)).to_have_value('稍后继续补充分页参数')
        expect(first.get_by_text('上次执行已中断', exact=False)).to_have_count(0)

        send(first, 'hold')
        expect(first.get_by_role('button', name='停止本轮', exact=True)).to_be_enabled()
        saved_drafts = first.evaluate("window.__actions.filter(item => item.action?.type === 'draft').length")
        first.get_by_role('textbox', name='消息', exact=True).fill('')
        first.get_by_role('textbox', name='消息', exact=True).fill('hold')
        first.wait_for_function("count => window.__actions.filter(item => item.action?.type === 'draft').length > count", arg=saved_drafts)
        first.get_by_role('button', name='停止本轮', exact=True).click()
        connected(first)
        expect(first.get_by_role('textbox', name='消息', exact=True)).to_have_value('hold')
        first.reload()
        expect(first.get_by_role('textbox', name='消息', exact=True)).to_have_value('hold')

        send(first, 'permission')
        expect(first.get_by_role('button', name='Allow this write', exact=True)).to_be_visible()
        first.screenshot(path=str(artifacts / 'acp-permission.png'), full_page=True)
        expect(second.get_by_role('button', name='Allow this write', exact=True)).to_have_count(0)
        # Reopening the panel loses local pending-send state, but a completed turn
        # must still clear its submitted draft through the host's acknowledgement.
        first.reload()
        expect(composer).to_have_value('permission')
        # Closing and creating a panel also resets its edit revisions and routing ID.
        assert first.request.post(origin + '/reopen?task=0').ok
        first.reload()
        expect(composer).to_have_value('permission')
        first.get_by_role('button', name='Allow this write', exact=True).click()
        connected(first)
        assert inspect()['entries'][0]['output'] == 'Permission granted\n'
        expect(composer).to_have_value('')
        expect(first.get_by_role('button', name='发送', exact=True)).to_be_disabled()
        first.screenshot(path=str(artifacts / 'acp-reopened-completed-turn.png'), full_page=True)

        send(first, 'permission')
        expect(first.get_by_role('button', name='Allow this write', exact=True)).to_be_visible()
        first.get_by_role('button', name='停止本轮', exact=True).click()
        connected(first)
        expect(first.get_by_role('button', name='Allow this write', exact=True)).to_have_count(0)

        unsafe = '<img src="https://invalid.example/agent-image" onerror="alert(1)"> [command](command:workbench.action.closeWindow)'
        send(first, unsafe)
        expect(first.locator('.acp-message-agent').last.locator('.acp-message-text')).to_have_text('Echo: ' + unsafe)
        assert first.locator('.acp-transcript img, .acp-transcript a').count() == 0

        first.get_by_role('button', name='断开连接', exact=True).click()
        first.wait_for_function("window.__model.status === 'disconnected'")
        history = conversation(inspect()['entries'][0]['model']['record']['messages'])
        first.reload()
        expect(first.get_by_role('button', name='继续会话', exact=True)).to_be_enabled()
        first.get_by_role('button', name='继续会话', exact=True).click()
        connected(first)
        restored = conversation(inspect()['entries'][0]['model']['record']['messages'])
        assert restored == history, {'before': history, 'after': restored}

        send(first, 'crash')
        first.wait_for_function("window.__model.status === 'error'")
        expect(first.get_by_role('textbox', name='消息', exact=True)).to_have_value('crash')
        expect(first.get_by_text('上次执行已中断', exact=False)).to_be_visible()
        expect(first.get_by_role('button', name='结束 Agent 进程', exact=True)).to_be_enabled()
        first.get_by_role('button', name='结束 Agent 进程', exact=True).click()
        first.wait_for_function("window.__model.status === 'disconnected'")
        first.reload()
        expect(first.get_by_role('textbox', name='消息', exact=True)).to_have_value('crash')
        journal = inspect()['entries'][0]['journals'][0]
        prompts = [json.loads(line) for line in journal.splitlines() if json.loads(line).get('method') == 'session/prompt']
        assert sum(any(part.get('text') == 'crash' for part in item['params']['prompt']) for item in prompts) == 1

        second.get_by_role('button', name='新建会话', exact=True).click()
        second.wait_for_function("window.__model.status === 'disconnected' && !window.__model.record.sessionId")
        second.get_by_role('combobox', name='Agent 配置', exact=True).select_option('no-load')
        send(second, 'no-load turn')
        expect(second.locator('.acp-message-agent')).to_contain_text('Echo: no-load turn')
        second.get_by_role('button', name='断开连接', exact=True).click()
        second.wait_for_function("window.__model.status === 'disconnected'")
        expect(second.get_by_role('button', name='继续会话', exact=True)).to_be_disabled()
        expect(second.get_by_text('此 Agent 未声明支持恢复旧会话', exact=False)).to_be_visible()

        second.request.post(origin + '/reset-release?task=1')
        try:
            second.get_by_role('button', name='新建会话', exact=True).click()
            second.wait_for_function("!window.__model.record.sessionId && window.__model.status === 'resetting'")
            expect(second.get_by_text('正在新建会话', exact=True)).to_be_visible()
            expect(second.get_by_role('button', name='连接 Agent', exact=True)).to_be_disabled()
            expect(second.get_by_role('combobox', name='Agent 配置', exact=True)).to_be_disabled()
            second.screenshot(path=str(artifacts / 'acp-resetting.png'), full_page=True)
        finally:
            second.request.delete(origin + '/reset-release?task=1')
        second.wait_for_function("window.__model.status === 'disconnected'")
        second.get_by_role('combobox', name='Agent 配置', exact=True).select_option('auth')
        second.get_by_role('button', name='连接 Agent', exact=True).click()
        expect(second.get_by_role('button', name='Fixture login', exact=True)).to_be_visible()
        expect(second.get_by_role('button', name='External login', exact=True)).to_have_count(0)
        second.get_by_role('button', name='Fixture login', exact=True).click()
        connected(second)
        expect(second.get_by_role('button', name='Fixture login', exact=True)).to_have_count(0)

        second.get_by_role('button', name='新建会话', exact=True).click()
        second.wait_for_function("!window.__model.record.profileId")
        second.get_by_role('combobox', name='Agent 配置', exact=True).select_option('incompatible')
        second.get_by_role('button', name='连接 Agent', exact=True).click()
        second.wait_for_function("window.__model.status === 'error'")
        expect(second.get_by_role('button', name='新建会话', exact=True)).to_be_enabled()
        second.get_by_role('button', name='结束 Agent 进程', exact=True).click()
        second.wait_for_function("window.__model.status === 'disconnected'")
        expect(second.get_by_role('combobox', name='Agent 配置', exact=True)).to_be_disabled()
        second.get_by_role('button', name='新建会话', exact=True).click()
        second.wait_for_function("!window.__model.record.profileId")
        second.get_by_role('combobox', name='Agent 配置', exact=True).select_option('normal')
        second.get_by_role('button', name='连接 Agent', exact=True).click()
        connected(second)

        first.get_by_role('button', name='新建会话', exact=True).click()
        first.wait_for_function("window.__model.status === 'disconnected' && !window.__model.record.profileId")
        first.get_by_role('combobox', name='Agent 配置', exact=True).select_option('controls')
        first.get_by_role('button', name='连接 Agent', exact=True).click()
        connected(first)
        model_selector = first.get_by_role('combobox', name='模型', exact=True)
        thinking = first.get_by_role('checkbox', name='显示思考', exact=True)
        expect(model_selector).to_have_value('fast')
        expect(thinking).not_to_be_visible()
        first.locator('.acp-extra-options summary').click()
        expect(thinking).not_to_be_checked()
        expect(first.get_by_role('combobox', name='会话模式', exact=True)).to_have_count(0)

        # Commands prepare an editable prompt, preserving chosen context as arguments.
        composer.fill('保留的草稿')
        first.get_by_text('Agent 命令', exact=True).click()
        first.get_by_role('button', name='/explain', exact=True).click()
        expect(composer).to_have_value('/explain 保留的草稿')
        saved_draft(first, '/explain 保留的草稿')
        controls_journal = inspect()['entries'][0]['journals'][4]
        assert not any(json.loads(line).get('method') == 'session/prompt' for line in controls_journal.splitlines())
        model_selector.select_option('deep')
        first.wait_for_function("window.__model.controls.configOptions.find(option => option.id === 'model')?.currentValue === 'deep' && !window.__model.controls.configuring")
        expect(model_selector).to_have_value('deep')
        thinking.click()
        first.wait_for_function("window.__model.controls.configOptions.find(option => option.id === 'thinking')?.currentValue === true && !window.__model.controls.configuring")
        expect(thinking).to_be_checked()
        expect(composer).to_have_value('/explain 保留的草稿')

        send(first, 'session-updates')
        connected(first)
        expect(first.get_by_text('Agent 会话：测试会话标题', exact=True)).not_to_be_visible()
        first.get_by_text('任务与会话信息', exact=True).click()
        expect(first.get_by_text('Agent 会话：测试会话标题', exact=True)).to_be_visible()
        expect(first.get_by_label('会话用量', exact=True)).to_contain_text('1,200 / 8,000 tokens')
        expect(first.get_by_label('会话用量', exact=True)).to_contain_text('0.02 USD')
        expect(first.get_by_text('会话更新提示', exact=True)).to_be_visible()
        expect(first.locator('.acp-transcript')).not_to_contain_text('会话更新提示')
        expect(first.get_by_text('压缩完成', exact=True)).to_be_visible()
        expect(first.get_by_text('已保留任务目标与关键结论', exact=False)).to_be_visible()
        thought = first.locator('.acp-message-thought')
        expect(thought.locator('.acp-message-text')).not_to_be_visible()
        thought.get_by_text('查看思考过程', exact=True).click()
        expect(thought.locator('.acp-message-text')).to_have_text('正在检查任务上下文')
        first.screenshot(path=str(artifacts / 'acp-session-controls.png'), full_page=True)

        send(first, 'hold')
        first.wait_for_function("window.__model.status === 'running'")
        expect(model_selector).to_be_disabled()
        expect(thinking).to_be_disabled()
        first.get_by_role('button', name='停止本轮', exact=True).click()
        connected(first)
        first.get_by_role('button', name='断开连接', exact=True).click()
        first.wait_for_function("window.__model.status === 'disconnected'")
        expect(model_selector).to_have_count(0)
        expect(thinking).to_have_count(0)
        expect(first.get_by_label('会话用量', exact=True)).to_have_count(0)
        expect(first.get_by_text('会话更新提示', exact=True)).to_have_count(0)
        expect(first.get_by_role('button', name='/explain', exact=True)).to_have_count(0)
        first.get_by_role('button', name='继续会话', exact=True).click()
        connected(first)
        expect(model_selector).to_be_enabled()

        first.get_by_role('button', name='新建会话', exact=True).click()
        first.wait_for_function("window.__model.status === 'disconnected' && !window.__model.record.profileId")
        first.get_by_role('combobox', name='Agent 配置', exact=True).select_option('legacy-modes')
        first.get_by_role('button', name='连接 Agent', exact=True).click()
        connected(first)
        mode_selector = first.get_by_role('combobox', name='会话模式', exact=True)
        expect(mode_selector).to_have_value('ask')
        mode_selector.select_option('code')
        first.wait_for_function("window.__model.controls.modes.currentModeId === 'code' && !window.__model.controls.configuring")
        expect(mode_selector).to_have_value('code')
        expect(model_selector).to_have_count(0)

        first.set_viewport_size({'width': 360, 'height': 900})
        first.evaluate("document.body.className = 'vscode-dark'")
        first.add_style_tag(content=''' :root { --vscode-editor-background:#1f1f1f; --vscode-editor-foreground:#ccc;
          --vscode-button-background:#0078d4; --vscode-button-foreground:white;
          --vscode-input-background:#313131; --vscode-descriptionForeground:#aaa;
          --vscode-textCodeBlock-background:#292929; --vscode-button-secondaryBackground:#313131;
          --vscode-button-secondaryForeground:#ccc; --vscode-widget-border:#555; }''')
        assert first.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        expect(first.get_by_role('textbox', name='消息', exact=True)).to_have_css('color', 'rgb(204, 204, 204)')
        first.screenshot(path=str(artifacts / 'acp-dark-mobile.png'), full_page=True)
        assert inspect()['primaryStatus'] == ''
        assert not errors, errors
        assert first.evaluate('window.__hostError') is None
        assert second.evaluate('window.__hostError') is None
        browser.close()
    print('ACP browser flows passed: task isolation, parallel conversations, permissions, cancellation, delayed completion with reload and follow-up, unacknowledged completion clears, batched selection appends, in-flight drafts, stale models/sends, new-conversation edits, reopened-turn acknowledgement, restore, crash, authentication, failed-profile recovery, safe text, config and mode changes, command drafts, thought/usage updates and disconnected controls.')
finally:
    host.terminate()
    host.wait(timeout=30)
