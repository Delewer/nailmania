import React from 'react'
import { Icon, useShop } from '../shop.jsx'

export function CatalogUnavailable(){
  const {t} = useShop();
  return (
    <div className="page-empty catalog-unavailable" role="alert">
      <Icon n="store" s={56}/>
      <h2>{t("catalogUnavailableTitle")}</h2>
      <p>{t("catalogUnavailableText")}</p>
      <button className="btn btn-dark" type="button" onClick={()=>window.location.reload()}>{t("retry")}</button>
    </div>
  );
}
