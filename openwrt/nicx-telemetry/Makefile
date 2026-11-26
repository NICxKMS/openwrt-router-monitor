include $(TOPDIR)/rules.mk

PKG_NAME:=nicx-telemetry
PKG_VERSION:=1.0.0
PKG_RELEASE:=8
PKG_LICENSE:=MIT
PKGARCH:=all

include $(INCLUDE_DIR)/package.mk

define Package/nicx-telemetry
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Outbound privacy-conscious router telemetry
  DEPENDS:=+curl +ca-bundle +jshn +jsonfilter +ubus +uci +rpcd +coreutils-stat
endef

define Package/nicx-telemetry/description
 BusyBox ash collectors and bounded RAM queue. Outbound verified HTTPS only.
 Optional iw and ping6 expose additional capabilities when installed.
endef

define Package/nicx-telemetry/conffiles
/etc/config/nicx-telemetry
endef

define Build/Compile
endef

define Package/nicx-telemetry/install
	$(CP) ./files/* $(1)/
	$(INSTALL_DIR) $(1)/etc/nicx-telemetry
	chmod 700 $(1)/etc/nicx-telemetry
	chmod 755 $(1)/etc/init.d/nicx-telemetry $(1)/usr/libexec/rpcd/nicx.telemetry $(1)/usr/lib/nicx-telemetry/agent.sh
endef

$(eval $(call BuildPackage,nicx-telemetry))
