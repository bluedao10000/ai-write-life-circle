import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { SiteContext, emptySite } from '../site/context'
import { Header } from '../site/kit'
import { Btn, Field, Seg } from '../components/vnext/ui'

afterEach(() => cleanup())

function publicHeader(path: string) {
  return render(
    <SiteContext.Provider value={{ ...emptySite, path }}>
      <Header />
    </SiteContext.Provider>,
  )
}

it('marks the current public page and exposes the mobile menu state', async () => {
  const user = userEvent.setup()
  publicHeader('/discover/recent')
  expect(screen.getByRole('link', { name: '最近更新' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('link', { name: '发现作品' })).not.toHaveAttribute('aria-current')
  const menu = screen.getByRole('button', { name: '菜单' })
  expect(menu).toHaveAttribute('aria-expanded', 'false')
  expect(menu).toHaveAttribute('aria-controls', 'story2u-mobile-nav')
  await user.click(menu)
  expect(menu).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('navigation', { name: '移动导航' })).toBeVisible()
})

it('marks the selected studio space and keeps a loading button blocked', () => {
  render(
    <>
      <Seg label="主导航" value="read" onChange={() => {}} options={[['inspire', '灵感'], ['read', '阅读'], ['book', '书']]} />
      <Btn loading>保存</Btn>
    </>,
  )
  expect(screen.getByRole('tab', { name: '阅读' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('tab', { name: '灵感' })).not.toHaveAttribute('aria-current')
  const button = screen.getByRole('button', { name: '保存' })
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('aria-busy', 'true')
})

it('associates field errors with the input', () => {
  render(<Field label="章节名" value="" onChange={() => {}} error="请输入章节名" />)
  const input = screen.getByRole('textbox', { name: '章节名' })
  expect(input).toHaveAttribute('aria-invalid', 'true')
  expect(screen.getByText('请输入章节名')).toBeVisible()
  expect(input.getAttribute('aria-describedby')).toBe(screen.getByText('请输入章节名').id)
})
