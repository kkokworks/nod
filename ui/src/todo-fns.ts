// The server functions of the todo pages. Their handlers run on the server only.
import { createServerFn } from '@tanstack/react-start'
import {
  type DoneShown,
  doneShown,
  int,
  type RawEdit,
  type RawProjectEdit,
  rawEdit,
  rawProjectEdit,
  record,
  text,
} from './input'
import {
  addProject,
  capture,
  donePage,
  editProject,
  editTodo,
  focusPage,
  lists,
  projectsPage,
  todoPage,
} from './todos.server'

export const getLists = createServerFn({ method: 'GET' }).handler(() => lists())

export const getDone = createServerFn({ method: 'GET' })
  .validator((s: DoneShown) => doneShown(s))
  .handler(({ data }) => donePage(data))

export const getTodo = createServerFn({ method: 'GET' })
  .validator((id: number) => int(id, 'todo id'))
  .handler(({ data }) => todoPage(data))

export const getFocus = createServerFn({ method: 'GET' }).handler(() => focusPage())

export const getProjects = createServerFn({ method: 'GET' }).handler(() => projectsPage())
export const captureTodo = createServerFn({ method: 'POST' })
  .validator((title: string) => text(title, 'title'))
  .handler(({ data }) => capture(data))

export const changeTodo = createServerFn({ method: 'POST' })
  .validator((c: { id: number; edit: RawEdit }) => {
    const o = record(c, 'change')
    return { id: int(o.id, 'todo id'), edit: rawEdit(o.edit) }
  })
  .handler(({ data }) => editTodo(data.id, data.edit))

export const newProject = createServerFn({ method: 'POST' })
  .validator((p: { title: string; outcome: string }) => {
    const o = record(p, 'project')
    return { title: text(o.title, 'title'), outcome: text(o.outcome, 'outcome') }
  })
  .handler(({ data }) => addProject(data.title, data.outcome))

export const changeProject = createServerFn({ method: 'POST' })
  .validator((c: { id: number; edit: RawProjectEdit }) => {
    const o = record(c, 'change')
    return { id: int(o.id, 'project id'), edit: rawProjectEdit(o.edit) }
  })
  .handler(({ data }) => editProject(data.id, data.edit))
