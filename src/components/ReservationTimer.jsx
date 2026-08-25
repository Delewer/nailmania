import React from 'react';
import { useShop } from '../shop.jsx';

const remainingTime = (expiresAt, now) => {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
};

export function ReservationTimer({ expiresAt }) {
  const { t } = useShop();
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (!expiresAt) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) return null;
  const expired = Date.parse(expiresAt) <= now;
  return (
    <p className={`reservation-timer${expired ? ' expired' : ''}`} role="status" aria-live="polite">
      {expired
        ? t('reservationExpired')
        : t('reservationExpiresIn').replace('{time}', remainingTime(expiresAt, now))}
    </p>
  );
}
