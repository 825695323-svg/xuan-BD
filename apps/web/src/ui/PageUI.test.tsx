import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageActions, PageButton, PageEmpty, PageField, PageHeading, PageSearch } from './PageUI.js';

test('目录与内容搜索使用相同组件并保留无障碍名称', () => {
  const navigation = renderToStaticMarkup(<PageSearch compact label="搜索来源" value="A 股" onChange={() => undefined} />);
  const content = renderToStaticMarkup(<PageSearch label="搜索材料" value="" onChange={() => undefined} />);
  assert.match(navigation, /class="data-search ui-page-search data-nav-search"/u);
  assert.match(navigation, /type="search"/u);
  assert.match(navigation, /aria-label="搜索来源"/u);
  assert.match(navigation, /value="A 股"/u);
  assert.doesNotMatch(content, /data-nav-search/u);
  assert.match(content, /aria-label="搜索材料"/u);
});

test('统一页面标题遵守语义层级与可选说明', () => {
  const output = renderToStaticMarkup(<PageHeading level="h3" title="基础算法" description="只读展示"
    actions={<PageButton>刷新</PageButton>} />);
  assert.match(output, /<h3 class="ui-page-heading-title">基础算法<\/h3>/u);
  assert.match(output, /class="ui-page-heading-description">只读展示/u);
  assert.match(output, /class="ui-page-heading-actions"/u);
});

test('加载与不可用是状态，空结果不是错误', () => {
  const loading = renderToStaticMarkup(<PageEmpty state="loading">读取中</PageEmpty>);
  const missing = renderToStaticMarkup(<PageEmpty state="unavailable">能力未装配</PageEmpty>);
  const empty = renderToStaticMarkup(<PageEmpty>暂无记录</PageEmpty>);
  assert.match(loading, /role="status"/u);
  assert.match(missing, /data-state="unavailable"/u);
  assert.doesNotMatch(empty, /role="alert"/u);
  assert.doesNotMatch(empty, /role="status"/u);
});

test('按钮默认不提交表单，明确区分主要操作与无障碍表单标签', () => {
  const buttons = renderToStaticMarkup(<PageActions align="end">
    <PageButton>关闭</PageButton>
    <PageButton variant="primary" disabled>执行</PageButton>
  </PageActions>);
  assert.match(buttons, /data-align="end"/u);
  assert.match(buttons, /class="text-button"/u);
  assert.match(buttons, /class="primary-button"/u);
  assert.equal((buttons.match(/type="button"/gu) ?? []).length, 2);
  assert.match(buttons, /disabled=""/u);
  const field = renderToStaticMarkup(<PageField label="参数"><textarea defaultValue="{}" /></PageField>);
  assert.match(field, /<label class="field-label ui-page-field"/u);
  assert.match(field, /<textarea/u);
});
