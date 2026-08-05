# Развёртывание через GitHub и Render

## 1. Загрузить проект в GitHub

Создайте **приватный** репозиторий, например `bitrix24-duty`. Загрузите в его корень содержимое папки `duty-app` — файлы `Dockerfile`, `server.mjs`, `package.json` и папку `public` должны лежать в корне репозитория.

Через Terminal это можно сделать так:

```bash
cd /Users/New/Documents/Codex/2026-08-05/new-chat/outputs/duty-app
git init
git add .
git commit -m "Initial duty roster"
git branch -M main
git remote add origin https://github.com/<ваша-организация>/bitrix24-duty.git
git push -u origin main
```

Файл `.env` и база `duty.sqlite` не попадут в GitHub благодаря `.gitignore`.

## 2. Создать сервис в Render

1. Войдите на [dashboard.render.com](https://dashboard.render.com/).
2. Нажмите **New → Web Service**.
3. Подключите GitHub, выберите репозиторий `bitrix24-duty` и ветку `main`.
4. В поле **Language** выберите **Docker**. Root Directory оставьте пустым, если файлы проекта лежат в корне репозитория.
5. Дайте сервису имя, например `duty-novoi`. Render выдаст адрес `https://duty-novoi.onrender.com` и HTTPS-сертификат.
6. В разделе **Advanced** добавьте переменные окружения:
   - `DATABASE_PATH` = `/app/data/duty.sqlite`
   - `ADMIN_TOKEN` = длинная случайная строка, например результат `openssl rand -hex 32`.
7. Там же добавьте **Persistent Disk**: mount path `/app/data`, размер 1 GB.
8. Нажмите **Create Web Service** и дождитесь статуса **Live**.

Не используйте бесплатный экземпляр для рабочей версии с SQLite: постоянный диск доступен для платных Web Service. Без постоянного диска данные графика удалятся при следующем redeploy.

## 3. Проверить

Откройте `https://duty-novoi.onrender.com`. Адрес доступен по HTTPS — его уже можно указать в Bitrix24. При каждом push в ветку `main` Render автоматически пересоберёт и развернёт новую версию.

## 4. Установить в Bitrix24

На портале `novoi.bitrix24.kz` откройте **Приложения → Ресурсы разработчика → Другое → Локальное приложение**. Укажите:

- название — `Дежурства`;
- путь к приложению — `https://duty-novoi.onrender.com/`;
- путь первоначальной установки — `https://duty-novoi.onrender.com/install`;
- права — `user`, `im` и базовые права приложения;
- пункт главного меню — `Дежурства`.

После первого сохранения Bitrix24 передаст приложению OAuth-данные на адрес `/install`.

## 5. Затем

Вернитесь сюда с публичным адресом Render и `client_id` созданного локального приложения. Не передавайте `client_secret`, токены или `ADMIN_TOKEN`: они сохраняются только в Secrets/Environment Render. На этом шаге подключается проверка роли администратора Bitrix24, настоящие аватары и сообщения сотруднику за три часа до дежурства.
