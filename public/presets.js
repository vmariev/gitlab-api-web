// Готовые запросы. Плейсхолдеры вида :id в пути превращаются в поля «Параметры пути»
// и при отправке URL-кодируются (поэтому ID проекта можно указать как group/subgroup/project).
export const PRESETS = [
  {
    group: "Пользователь",
    items: [
      { name: "Текущий пользователь", method: "GET", path: "/user" },
      { name: "Поиск пользователей", method: "GET", path: "/users", query: { search: "" } },
      { name: "Версия GitLab", method: "GET", path: "/version" },
    ],
  },
  {
    group: "Проекты",
    items: [
      { name: "Мои проекты", method: "GET", path: "/projects", query: { membership: "true", simple: "true", order_by: "last_activity_at", per_page: "20" } },
      { name: "Поиск проектов", method: "GET", path: "/projects", query: { search: "", simple: "true" } },
      { name: "Проект", method: "GET", path: "/projects/:id" },
      { name: "Участники проекта", method: "GET", path: "/projects/:id/members/all" },
      { name: "Ветки", method: "GET", path: "/projects/:id/repository/branches", query: { search: "" } },
      { name: "Теги", method: "GET", path: "/projects/:id/repository/tags" },
      { name: "Коммиты", method: "GET", path: "/projects/:id/repository/commits", query: { ref_name: "", per_page: "20" } },
      { name: "Файл из репозитория", method: "GET", path: "/projects/:id/repository/files/:file_path", query: { ref: "main" } },
      { name: "Создать ветку", method: "POST", path: "/projects/:id/repository/branches", body: { branch: "feature/new", ref: "main" } },
    ],
  },
  {
    group: "Merge Requests",
    items: [
      { name: "Мои открытые MR", method: "GET", path: "/merge_requests", query: { state: "opened", scope: "created_by_me" } },
      { name: "MR на мне (ревью)", method: "GET", path: "/merge_requests", query: { state: "opened", scope: "all", reviewer_username: "" } },
      { name: "MR проекта", method: "GET", path: "/projects/:id/merge_requests", query: { state: "opened" } },
      { name: "MR", method: "GET", path: "/projects/:id/merge_requests/:merge_request_iid" },
      { name: "Изменения MR", method: "GET", path: "/projects/:id/merge_requests/:merge_request_iid/diffs" },
      { name: "Комментарии MR", method: "GET", path: "/projects/:id/merge_requests/:merge_request_iid/notes", query: { sort: "asc" } },
      {
        name: "Создать MR",
        method: "POST",
        path: "/projects/:id/merge_requests",
        body: { source_branch: "feature/new", target_branch: "main", title: "Новый merge request", remove_source_branch: true },
      },
      { name: "Комментировать MR", method: "POST", path: "/projects/:id/merge_requests/:merge_request_iid/notes", body: { body: "Текст комментария" } },
      { name: "Approve MR", method: "POST", path: "/projects/:id/merge_requests/:merge_request_iid/approve" },
      { name: "Влить MR", method: "PUT", path: "/projects/:id/merge_requests/:merge_request_iid/merge", body: { should_remove_source_branch: true } },
    ],
  },
  {
    group: "Issues",
    items: [
      { name: "Мои issues", method: "GET", path: "/issues", query: { state: "opened", scope: "assigned_to_me" } },
      { name: "Issues проекта", method: "GET", path: "/projects/:id/issues", query: { state: "opened", labels: "" } },
      { name: "Issue", method: "GET", path: "/projects/:id/issues/:issue_iid" },
      { name: "Создать issue", method: "POST", path: "/projects/:id/issues", body: { title: "Новая задача", description: "", labels: "" } },
      { name: "Закрыть issue", method: "PUT", path: "/projects/:id/issues/:issue_iid", body: { state_event: "close" } },
      { name: "Комментировать issue", method: "POST", path: "/projects/:id/issues/:issue_iid/notes", body: { body: "Текст комментария" } },
    ],
  },
  {
    group: "CI/CD",
    items: [
      { name: "Пайплайны", method: "GET", path: "/projects/:id/pipelines", query: { ref: "", status: "", per_page: "20" } },
      { name: "Пайплайн", method: "GET", path: "/projects/:id/pipelines/:pipeline_id" },
      { name: "Джобы пайплайна", method: "GET", path: "/projects/:id/pipelines/:pipeline_id/jobs" },
      { name: "Лог джобы", method: "GET", path: "/projects/:id/jobs/:job_id/trace" },
      { name: "Запустить пайплайн", method: "POST", path: "/projects/:id/pipeline", body: { ref: "main", variables: [] } },
      { name: "Перезапустить пайплайн", method: "POST", path: "/projects/:id/pipelines/:pipeline_id/retry" },
      { name: "Отменить пайплайн", method: "POST", path: "/projects/:id/pipelines/:pipeline_id/cancel" },
      { name: "Перезапустить джобу", method: "POST", path: "/projects/:id/jobs/:job_id/retry" },
    ],
  },
  {
    group: "Группы",
    items: [
      { name: "Мои группы", method: "GET", path: "/groups", query: { min_access_level: "10" } },
      { name: "Группа", method: "GET", path: "/groups/:id" },
      { name: "Проекты группы", method: "GET", path: "/groups/:id/projects", query: { include_subgroups: "true", simple: "true" } },
      { name: "Участники группы", method: "GET", path: "/groups/:id/members/all" },
    ],
  },
];
