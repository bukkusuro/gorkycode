import { Trash2, Upload, UserRound } from 'lucide-react';
import Avatar from './Avatar';
import type { useProfile } from './useProfile';
export default function ProfilePanel({ profile }: { profile: ReturnType<typeof useProfile> }) {
  const { name, avatar, upload, removeAvatar, rename } = profile;
  return (
    <>
      <header className="profile-modal-heading">
        <span className="settings-section-icon">
          <UserRound size={25} />
        </span>
        <div>
          <h2 id="modal-title">Профиль</h2>
          <p>Ваше имя и изображение в ВОКСА</p>
        </div>
      </header>
      <div className="profile-modal-content">
        <section className="profile-card">
          <h3>Фото профиля</h3>
          <p className="settings-description">
            Добавьте изображение, чтобы сделать профиль узнаваемым
          </p>
          <div className="profile-photo-row">
            <Avatar name={name} src={avatar} large />
            <div className="profile-photo-actions">
              <label className="profile-upload-button">
                <Upload size={17} />
                Загрузить изображение
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  aria-label="Загрузить изображение"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    void upload(file);
                  }}
                />
              </label>
              <button className="profile-remove-button" disabled={!avatar} onClick={removeAvatar}>
                <Trash2 size={16} />
                Удалить изображение
              </button>
            </div>
          </div>
          <p className="profile-image-hint">
            JPG или PNG до 5 МБ. Изображение уменьшается до 256 пикселей.
          </p>
        </section>
        <section className="profile-card">
          <label>
            Отображаемое имя
            <input
              maxLength={40}
              autoComplete="nickname"
              placeholder="Введите ваше имя"
              value={name}
              onChange={(event) => rename(event.target.value)}
            />
          </label>
          <p className="settings-description">Это имя отображается в верхней панели приложения.</p>
        </section>
      </div>
    </>
  );
}
