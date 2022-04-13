use std::sync::Arc;

use actix_web::web;

use htsget_config::config::Config;
use htsget_config::regex_resolver::RegexResolver;
use htsget_search::htsget::from_storage::HtsGetFromStorage;
use htsget_search::htsget::HtsGet;
use htsget_search::storage::local::LocalStorage;

use crate::handlers::{get, post, reads_service_info, variants_service_info};

pub mod handlers;

pub type HtsGetStorage = HtsGetFromStorage<LocalStorage>;

pub struct AppState<H: HtsGet> {
  pub htsget: Arc<H>,
  pub config: Config,
}

pub fn configure_server(service_config: &mut web::ServiceConfig, config: Config) {
  let htsget_path = config.htsget_path.clone();
  let regex_match = config.htsget_regex_match.clone();
  let regex_substitution = config.htsget_regex_substitution.clone();
  service_config
    .app_data(web::Data::new(AppState {
      htsget: Arc::new(HtsGetStorage::new(
        LocalStorage::new(
          htsget_path,
          RegexResolver::new(&regex_match, &regex_substitution).unwrap(),
        )
        .expect("Couldn't create a Storage with the provided path"),
      )),
      config,
    }))
    .service(
      web::scope("/reads")
        .route(
          "/service-info",
          web::get().to(reads_service_info::<HtsGetStorage>),
        )
        .route(
          "/service-info",
          web::post().to(reads_service_info::<HtsGetStorage>),
        )
        .route("/{id:.+}", web::get().to(get::reads::<HtsGetStorage>))
        .route("/{id:.+}", web::post().to(post::reads::<HtsGetStorage>)),
    )
    .service(
      web::scope("/variants")
        .route(
          "/service-info",
          web::get().to(variants_service_info::<HtsGetStorage>),
        )
        .route(
          "/service-info",
          web::post().to(variants_service_info::<HtsGetStorage>),
        )
        .route("/{id:.+}", web::get().to(get::variants::<HtsGetStorage>))
        .route("/{id:.+}", web::post().to(post::variants::<HtsGetStorage>)),
    );
}

#[cfg(test)]
mod tests {
  use actix_web::web::Bytes;
  use actix_web::{test, web, App};
  use async_trait::async_trait;

  use htsget_test_utils::{
    server_tests, Header as TestHeader, Response as TestResponse, TestRequest, TestServer,
  };

  use super::*;

  struct ActixTestServer {
    config: Config,
  }

  struct ActixTestRequest<T>(T);

  impl TestRequest for ActixTestRequest<test::TestRequest> {
    fn insert_header(self, header: TestHeader<impl Into<String>>) -> Self {
      Self(self.0.insert_header(header.into_tuple()))
    }

    fn set_payload(self, payload: impl Into<String>) -> Self {
      Self(self.0.set_payload(payload.into()))
    }

    fn uri(self, uri: impl Into<String>) -> Self {
      Self(self.0.uri(&uri.into()))
    }

    fn method(self, method: impl Into<String>) -> Self {
      Self(
        self
          .0
          .method(method.into().parse().expect("Expected valid method.")),
      )
    }
  }

  impl Default for ActixTestServer {
    fn default() -> Self {
      Self {
        config: server_tests::default_test_config(),
      }
    }
  }

  #[async_trait(?Send)]
  impl TestServer<ActixTestRequest<test::TestRequest>> for ActixTestServer {
    fn get_config(&self) -> &Config {
      &self.config
    }

    fn get_request(&self) -> ActixTestRequest<test::TestRequest> {
      ActixTestRequest(test::TestRequest::default())
    }

    async fn test_server(&self, request: ActixTestRequest<test::TestRequest>) -> TestResponse {
      let app = test::init_service(App::new().configure(
        |service_config: &mut web::ServiceConfig| {
          configure_server(service_config, self.config.clone());
        },
      ))
      .await;
      let response = request.0.send_request(&app).await;
      let status: u16 = response.status().into();
      let bytes: Bytes = test::read_body(response).await;
      TestResponse::new(status, bytes)
    }
  }

  #[actix_web::test]
  async fn test_get() {
    server_tests::test_get(&ActixTestServer::default()).await;
  }

  #[actix_web::test]
  async fn test_post() {
    server_tests::test_post(&ActixTestServer::default()).await;
  }

  #[actix_web::test]
  async fn test_parameterized_get() {
    server_tests::test_parameterized_get(&ActixTestServer::default()).await;
  }

  #[actix_web::test]
  async fn test_parameterized_post() {
    server_tests::test_parameterized_post(&ActixTestServer::default()).await;
  }

  #[actix_web::test]
  async fn test_service_info() {
    server_tests::test_service_info(&ActixTestServer::default()).await;
  }
}