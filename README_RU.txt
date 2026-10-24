ABUM UPGRADE — миграция с NxCreate на Cloudflare Pages + D1
============================================================

Что это
-------
- public/index.html — существующий интерфейс ABUM UPGRADE v6.2; API_BASE переключён на /api/.
- functions/api/[[path]].js — совместимый адаптер для существующих обработчиков app_state, app_upgrade,
  app_sell, промокодов, инвентаря, заявок на вывод и администратора.
- schema.sql — схема Cloudflare D1.

ВАЖНО
-----
1) Это перенос среды исполнения, а не доказательство того, что NxCreate был взломан.
2) Ничего не удаляйте в NxCreate, пока Cloudflare-версия не проверена.
3) Данные игроков из старой базы NxCreate НЕ переносятся автоматически. Перед переключением основной ссылки нужно
   экспортировать профили/промокоды/заявки и отдельно выполнить миграцию. Не начисляйте повторно награды до сверки.
4) Действия, меняющие баланс, должны быть тщательно протестированы до включения для игроков. Этот первый порт
   использует compare-and-swap на документах D1 и возвращает конфликт при конкурентной записи профиля; при 409
   игроку следует повторить действие. Перед запуском с реальными ценностями всё равно нужен тестовый прогон.
5) Не записывайте MAIN_APP_BOT_TOKEN в HTML или в GitHub.

Порядок установки через браузер (без командной строки)
-------------------------------------------------------
A. GitHub
1. Создайте Private repository, например abum-upgrade-cloudflare.
2. Нажмите Add file -> Upload files.
3. Распакуйте архив и загрузите папки public и functions, а также schema.sql и этот README.
   Убедитесь, что структура в репозитории выглядит так:
      public/index.html
      functions/api/[[path]].js
      schema.sql
4. Нажмите Commit changes. Не добавляйте никакие токены или пароли в репозиторий.

B. Cloudflare Pages
1. Создайте аккаунт на https://dash.cloudflare.com/sign-up
2. Workers & Pages -> Create application -> Pages -> Connect to Git.
3. Подключите только что созданный private GitHub repository.
4. Framework preset: None; Build command: оставить пустым; Build output directory: public.
5. Create/Deploy project. Сохраните адрес *.pages.dev; сначала используйте его для тестов.

C. D1 база
1. Cloudflare -> Workers & Pages -> D1 SQL Database -> Create database; имя: abum-upgrade-db.
2. Откройте базу -> Console и выполните весь SQL из schema.sql.
3. В Pages project -> Settings -> Bindings -> Add -> D1 database binding.
4. Variable name: DB; выберите abum-upgrade-db; Save и Redeploy.

D. Секреты и переменные
1. Pages project -> Settings -> Variables and Secrets -> Add.
2. Добавьте Secret MAIN_APP_BOT_TOKEN = токен ОСНОВНОГО Telegram-бота, который открывает Mini App.
3. Добавьте Variable ABUM_ADMIN_IDS = ваш числовой Telegram user ID (не bot ID).
4. Save; redeploy project, если UI предлагает это действие.
5. Секреты не копируйте в HTML и не присылайте в чат.

E. Проверка, не переключая игроков
1. Откройте https://<project>.pages.dev/api/upgrade_ping — ожидается JSON с statusCode 200. Этот health-check не требует D1; остальные API endpoints потребуют настроенный binding DB.
2. Откройте главную страницу *.pages.dev. Для profile-check приложение должно быть запущено из Telegram основного бота.
3. Проверьте профиль с тестовым аккаунтом, без начального баланса. Проверьте app_state, тестовый апгрейд, промокод и вывод.
4. Только после успешных проверок измените Menu Button URL основного бота на новый *.pages.dev адрес.
5. Старый NxCreate app и сервер держите выключенными/неиспользуемыми, но не удаляйте до экспорта и сверки данных.

Лимиты бесплатного плана
------------------------
Официальная документация Cloudflare указывает для Workers Free 100 000 запросов в день, а для D1 Free — 5 млн прочитанных строк
в день, 100 000 записанных строк в день и 5 GB общего хранения. При превышении лимита запросы к D1 могут перестать проходить до сброса
лимита или перехода на платный план. Проверьте текущие условия в панели перед запуском.

Ссылки
------
Cloudflare dashboard: https://dash.cloudflare.com/
Pages Functions + D1 bindings: https://developers.cloudflare.com/pages/functions/bindings/
Pages routing: https://developers.cloudflare.com/pages/functions/routing/
D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
Secrets: https://developers.cloudflare.com/pages/functions/bindings/
